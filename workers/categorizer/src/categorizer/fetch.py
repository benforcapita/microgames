from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Sequence
from typing import Literal, NamedTuple, Protocol


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


class Transport(Protocol):
    def open(self, path: str) -> ByteSource: ...


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
    return 1 <= len(path) <= 512 and _PATH.search(path) is None


def _read_limited(source: ByteSource, limit: int) -> bytes | None:
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


__all__ = (
    "ByteSource",
    "DownloadCode",
    "DownloadFailure",
    "DownloadOk",
    "DownloadedFile",
    "FileRequest",
    "Transport",
    "download_files",
)
