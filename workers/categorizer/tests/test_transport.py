from __future__ import annotations

import gzip
import hashlib
from collections.abc import Iterator

import httpx
import pytest

import support
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


def _status_client(status: int, body: bytes = b"data") -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def _client_with_status(stream: _TrackedStream, status: int) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, stream=stream)

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


@pytest.mark.parametrize(("status", "code"), [(404, "fetch_4xx"), (500, "fetch_5xx")])
def test_open_exposes_http_status_and_body_stays_bounded(status: int, code: str) -> None:
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
    assert result.code == code
    assert sum(pulled) <= _TOTAL + _CHUNK


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (199, "fetch_4xx"),
        (301, "fetch_4xx"),
        (302, "fetch_4xx"),
        (307, "fetch_4xx"),
        (404, "fetch_4xx"),
        (418, "fetch_4xx"),
        (499, "fetch_4xx"),
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


def test_success_2xx_status_proceeds() -> None:
    for status in (200, 201, 299):
        transport = HttpxTransport(client=_status_client(status, b"ok"), base_url="https://cdn.test/")
        result = download_files((FileRequest(path="index.html"),), transport)
        assert isinstance(result, DownloadOk), status


def test_transport_sends_accept_encoding_identity() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("accept-encoding", ""))
        return httpx.Response(200, content=b"ok")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadOk)
    assert seen == ["identity"]


class _FailStream(httpx.SyncByteStream):
    def __init__(self, error: Exception) -> None:
        self._error = error
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        yield b"partial"
        raise self._error

    def close(self) -> None:
        self.closed = True


def _error_client(error: Exception, *, at_send: bool = False) -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        if at_send:
            raise error
        return httpx.Response(200, stream=_FailStream(error))

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_mid_stream_transport_error_is_fetch_5xx_and_closes() -> None:
    client = _error_client(httpx.ReadError("reset"))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_5xx"


def test_mid_stream_error_still_closes_response() -> None:
    stream = _FailStream(httpx.RemoteProtocolError("dropped"))

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_5xx"
    assert stream.closed


def test_send_transport_error_is_fetch_5xx() -> None:
    client = _error_client(httpx.ConnectError("refused"), at_send=True)
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_5xx"


def test_send_timeout_is_fetch_timeout() -> None:
    client = _error_client(httpx.ConnectTimeout("slow"), at_send=True)
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"


def test_mid_stream_timeout_is_fetch_timeout() -> None:
    client = _error_client(httpx.ReadTimeout("slow"))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files((FileRequest(path="index.html"),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"


class _DripStream(httpx.SyncByteStream):
    def __init__(
        self,
        clock: support.ManualClock,
        pulled: list[int],
        chunks: int = -1,
        step: float = 2.0,
    ) -> None:
        self._clock = clock
        self._pulled = pulled
        self._chunks = chunks
        self._step = step
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        left = self._chunks
        while left != 0:
            left -= 1
            self._clock.advance(self._step)
            self._pulled.append(_CHUNK)
            yield b"x" * _CHUNK

    def close(self) -> None:
        self.closed = True


def test_slow_drip_hits_overall_deadline() -> None:
    clock = support.ManualClock()
    pulled: list[int] = []
    stream = _DripStream(clock, pulled)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="index.html"),), transport, timeout=5.0, clock=clock.monotonic
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"
    assert len(pulled) <= 4
    assert stream.closed


def test_zero_deadline_stops_before_any_open() -> None:
    clock = support.ManualClock()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=b"ok")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="index.html"),), transport, timeout=0.0, clock=clock.monotonic
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"
    assert calls == []


def test_clock_landing_exactly_on_deadline_mid_read_is_fetch_timeout() -> None:
    clock = support.ManualClock()
    pulled: list[int] = []
    stream = _DripStream(clock, pulled, chunks=2)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="index.html"),), transport, timeout=4.0, clock=clock.monotonic
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"
    assert pulled == [_CHUNK, _CHUNK]
    assert stream.closed


def test_default_overall_timeout_is_sixty_seconds() -> None:
    clock = support.ManualClock()
    pulled: list[int] = []
    stream = _DripStream(clock, pulled, chunks=3, step=30.0)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="index.html"),), transport, clock=clock.monotonic
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"
    assert pulled == [_CHUNK, _CHUNK]


def test_deadline_blocks_opening_the_next_file() -> None:
    clock = support.ManualClock()
    pulled: list[int] = []
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, stream=_DripStream(clock, pulled, chunks=3))

    client = httpx.Client(transport=httpx.MockTransport(handler))
    transport = HttpxTransport(client=client, base_url="https://cdn.test/")
    result = download_files(
        (FileRequest(path="a.txt"), FileRequest(path="b.txt")),
        transport,
        timeout=5.0,
        clock=clock.monotonic,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_timeout"
    assert calls == ["https://cdn.test/a.txt"]
