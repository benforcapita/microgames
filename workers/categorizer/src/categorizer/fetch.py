from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Iterator, Sequence
from typing import Literal, NamedTuple, Protocol, runtime_checkable

import httpx


class _Caps(NamedTuple):
    total_bytes: int
    max_files: int


_CAPS = _Caps(total_bytes=4 * 1024 * 1024, max_files=200)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_PATH = re.compile(r"(^/|\.\.|\\)")

DownloadCode = Literal[
    "bundle_mismatch",
    "bundle_path",
    "bundle_too_large",
    "bundle_file_count",
]


class FileRequest:
    __slots__ = ("content_sha256", "path")

    def __init__(self, *, path: str, content_sha256: str | None = None) -> None:
        object.__setattr__(self, "path", path)
        object.__setattr__(self, "content_sha256", content_sha256)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class ByteSource(Protocol):
    def read(self, n: int) -> bytes: ...


@runtime_checkable
class _Closeable(Protocol):
    def close(self) -> None: ...


class Transport(Protocol):
    def open(self, path: str) -> ByteSource: ...


class HttpxTransport:
    __slots__ = ("_base", "_client")

    def __init__(self, *, client: httpx.Client, base_url: str) -> None:
        object.__setattr__(self, "_client", client)
        object.__setattr__(self, "_base", base_url.rstrip("/") + "/")

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)

    def open(self, path: str) -> ByteSource:
        request = self._client.build_request("GET", self._base + path)
        return _HttpxBody(self._client.send(request, stream=True))


class _HttpxBody:
    __slots__ = ("_buf", "_chunks", "_response")

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._chunks: Iterator[bytes] = (
            iter((response.content,)) if response.is_stream_consumed else response.iter_raw()
        )
        self._buf = bytearray()

    def read(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = next(self._chunks, None)
            if chunk is None:
                break
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def close(self) -> None:
        self._response.close()


class DownloadedFile:
    __slots__ = ("body", "path")

    def __init__(self, *, path: str, body: bytes) -> None:
        object.__setattr__(self, "path", path)
        object.__setattr__(self, "body", body)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class DownloadOk:
    __slots__ = ("files",)

    def __init__(self, *, files: tuple[DownloadedFile, ...]) -> None:
        object.__setattr__(self, "files", files)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class DownloadFailure:
    __slots__ = ("code",)

    def __init__(self, *, code: DownloadCode) -> None:
        object.__setattr__(self, "code", code)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


def download_files(
    files: Sequence[FileRequest],
    transport: Transport,
    *,
    bundle_sha256: str | None = None,
) -> DownloadOk | DownloadFailure:
    snapshot = tuple(files)
    if len(snapshot) > _CAPS.max_files:
        return DownloadFailure(code="bundle_file_count")
    for item in snapshot:
        if not _path_ok(item.path):
            return DownloadFailure(code="bundle_path")
    for item in snapshot:
        digest = item.content_sha256
        if digest is not None and _SHA256.fullmatch(digest) is None:
            return DownloadFailure(code="bundle_mismatch")
    if bundle_sha256 is not None and _SHA256.fullmatch(bundle_sha256) is None:
        return DownloadFailure(code="bundle_mismatch")
    if bundle_sha256 is not None and not any(item.path == "index.html" for item in snapshot):
        return DownloadFailure(code="bundle_mismatch")
    accepted: list[DownloadedFile] = []
    total = 0
    for item in snapshot:
        limit = _CAPS.total_bytes - total
        body = _read_limited(transport.open(item.path), limit)
        if body is None:
            return DownloadFailure(code="bundle_too_large")
        digest = item.content_sha256
        check_bundle = bundle_sha256 is not None and item.path == "index.html"
        if digest is not None or check_bundle:
            actual = hashlib.sha256(body).hexdigest()
            if digest is not None and not _same_hash(actual, digest):
                return DownloadFailure(code="bundle_mismatch")
            if check_bundle and bundle_sha256 is not None and not _same_hash(actual, bundle_sha256):
                return DownloadFailure(code="bundle_mismatch")
        total += len(body)
        accepted.append(DownloadedFile(path=item.path, body=body))
    return DownloadOk(files=tuple(accepted))


def _same_hash(actual: str, expected: str) -> bool:
    return secrets.compare_digest(actual, expected)


def _path_ok(path: str) -> bool:
    return 1 <= len(path) <= 512 and "\x00" not in path and _PATH.search(path) is None


def _read_limited(source: ByteSource, limit: int) -> bytes | None:
    try:
        buf = bytearray()
        while len(buf) <= limit:
            need = limit + 1 - len(buf)
            chunk = source.read(need)
            if len(chunk) > need:
                chunk = chunk[:need]
            if chunk == b"":
                return bytes(buf)
            buf += chunk
        return None
    finally:
        if isinstance(source, _Closeable):
            source.close()


__all__ = (
    "ByteSource",
    "DownloadCode",
    "DownloadFailure",
    "DownloadOk",
    "DownloadedFile",
    "FileRequest",
    "HttpxTransport",
    "Transport",
    "download_files",
)
