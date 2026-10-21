from __future__ import annotations

import hashlib
from collections.abc import Iterator

import httpx
import pytest

from categorizer.fetch import (
    DownloadFailure,
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


def _status_client(status: int, body: bytes = b"data") -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (404, "fetch_4xx"),
        (418, "fetch_4xx"),
        (500, "fetch_5xx"),
        (503, "fetch_5xx"),
        (401, "fetch_unauthorized"),
        (403, "fetch_unauthorized"),
    ],
)
def test_http_status_maps_to_fetch_code_not_bundle_mismatch(status: int, code: str) -> None:
    wrong = hashlib.sha256(b"different").hexdigest()
    transport = HttpxTransport(client=_status_client(status), base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="index.html", content_sha256=wrong),),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == code
    assert result.code != "bundle_mismatch"


def test_error_status_without_hash_still_maps() -> None:
    transport = HttpxTransport(client=_status_client(404), base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_4xx"


def test_error_status_closes_stream() -> None:
    pulled: list[int] = []
    stream = _TrackedStream([b"chunk"], pulled)
    transport = HttpxTransport(
        client=_client_with_status(stream, 503), base_url="https://cdn.test/"
    )
    result = download_files((FileRequest(path="index.html"),), transport)
    assert result.code == "fetch_5xx"
    assert stream.closed


def _client_with_status(stream: _TrackedStream, status: int) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, stream=stream)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_success_2xx_status_proceeds() -> None:
    for status in (200, 201, 299):
        transport = HttpxTransport(client=_status_client(status, b"ok"), base_url="https://cdn.test/")
        result = download_files((FileRequest(path="index.html"),), transport)
        assert isinstance(result, DownloadOk), status
