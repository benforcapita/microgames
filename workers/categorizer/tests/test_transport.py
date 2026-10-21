from __future__ import annotations

import gzip
from collections.abc import Iterator

import httpx
import pytest

from categorizer.fetch import (
    DownloadOk,
    FileRequest,
    HttpxTransport,
    download_files,
)

_TOTAL = 4 * 1024 * 1024
_CHUNK = 64 * 1024


class _TrackedStream(httpx.SyncByteStream):
    def __init__(self, chunks: list[bytes], pulled: list[int]) -> None:
        self._chunks = chunks
        self._pulled = pulled
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self._chunks:
            self._pulled.append(len(chunk))
            yield chunk

    def close(self) -> None:
        self.closed = True


def _client(stream: _TrackedStream) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_transport_returns_body_and_closes() -> None:
    pulled: list[int] = []
    stream = _TrackedStream([b"alpha", b"beta"], pulled)
    transport = HttpxTransport(client=_client(stream), base_url="https://cdn.test/games/v1/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == b"alphabeta"
    assert pulled == [5, 4]
    assert stream.closed


def test_transport_stops_reading_at_cap() -> None:
    pulled: list[int] = []
    oversized = (_TOTAL // _CHUNK + 8) * _CHUNK
    chunks = [b"x" * _CHUNK] * (oversized // _CHUNK)
    stream = _TrackedStream(chunks, pulled)
    transport = HttpxTransport(client=_client(stream), base_url="https://cdn.test/")
    result = download_files((FileRequest(path="big.bin"),), transport)
    assert result.code == "bundle_too_large"
    assert sum(pulled) <= _TOTAL + _CHUNK
    assert stream.closed


def test_transport_joins_base_and_path() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=b"ok")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/games/v1")
    result = download_files((FileRequest(path="a/b.js"),), transport)
    assert isinstance(result, DownloadOk)
    assert seen == ["https://cdn.test/games/v1/a/b.js"]


def test_trailing_slash_base_joins_without_double_slash() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, content=b"ok")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/games/v1/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadOk)
    assert seen == ["https://cdn.test/games/v1/index.html"]


def test_read_stops_when_chunk_lands_exactly_on_cap_boundary() -> None:
    pulled: list[int] = []
    stream = _TrackedStream([b"x" * _TOTAL, b"y", b"z"], pulled)
    transport = HttpxTransport(client=_client(stream), base_url="https://cdn.test/")
    result = download_files((FileRequest(path="big.bin"),), transport)
    assert result.code == "bundle_too_large"
    assert pulled == [_TOTAL, 1]
    assert stream.closed


def test_gzip_encoded_body_is_served_raw() -> None:
    decompressed = b"\x00" * (5 * 1024 * 1024)
    compressed = gzip.compress(decompressed)
    assert len(compressed) < _TOTAL
    pulled: list[int] = []
    stream = _TrackedStream([compressed], pulled)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == compressed
    assert sum(pulled) == len(compressed)


def test_body_read_one_byte_twice_returns_successive_bytes() -> None:
    stream = _TrackedStream([b"ab"], [])
    transport = HttpxTransport(client=_client(stream), base_url="https://cdn.test/")
    body = transport.open("index.html")
    assert body.read(1) == b"a"
    assert body.read(1) == b"b"
    assert body.read(1) == b""
    body.close()
    assert stream.closed


@pytest.mark.parametrize("status", [404, 500])
def test_open_exposes_http_status_and_body_stays_bounded(status: int) -> None:
    pulled: list[int] = []
    chunks = [b"x" * _CHUNK] * (_TOTAL // _CHUNK + 1)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, stream=_TrackedStream(list(chunks), pulled))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    body = transport.open("index.html")
    assert body.status == status
    body.close()
    result = download_files((FileRequest(path="index.html"),), transport)
    assert result.code == "bundle_too_large"
    assert sum(pulled) <= _TOTAL + _CHUNK
