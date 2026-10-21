from __future__ import annotations

from collections.abc import Iterator

import httpx

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
