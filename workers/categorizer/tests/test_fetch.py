from __future__ import annotations

import hashlib

import pytest

from categorizer.fetch import (
    DownloadFailure,
    DownloadOk,
    FileRequest,
    download_files,
)

_FILE_CAP = 4_194_304
_TOTAL_CAP = 20_971_520


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Cursor:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0

    def read(self, n: int) -> bytes:
        chunk = self._data[self._offset : self._offset + n]
        self._offset += len(chunk)
        return chunk

    @property
    def pulled(self) -> int:
        return self._offset


class _MapTransport:
    def __init__(self, files: dict[str, bytes]) -> None:
        self._files = files
        self.opened: list[str] = []
        self.cursors: list[_Cursor] = []

    def open(self, path: str) -> _Cursor:
        self.opened.append(path)
        cursor = _Cursor(self._files[path])
        self.cursors.append(cursor)
        return cursor


def test_matching_files_return_bodies_in_request_order() -> None:
    first = b"alpha"
    second = b"beta"
    transport = _MapTransport({"index.html": first, "notes.txt": second})
    result = download_files(
        (
            FileRequest(path="index.html", content_sha256=_sha(first)),
            FileRequest(path="notes.txt"),
        ),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert [(item.path, item.body) for item in result.files] == [
        ("index.html", first),
        ("notes.txt", second),
    ]
    assert transport.opened == ["index.html", "notes.txt"]


def test_empty_request_returns_no_files_and_opens_nothing() -> None:
    transport = _MapTransport({})
    result = download_files((), transport)
    assert isinstance(result, DownloadOk)
    assert result.files == ()
    assert transport.opened == []


def test_duplicate_paths_are_downloaded_once_per_entry() -> None:
    body = b"same"
    transport = _MapTransport({"sprite.png": body})
    result = download_files(
        (
            FileRequest(path="sprite.png", content_sha256=_sha(body)),
            FileRequest(path="sprite.png", content_sha256=_sha(body)),
        ),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert [item.body for item in result.files] == [body, body]
    assert transport.opened == ["sprite.png", "sprite.png"]


def test_hash_mismatch_is_bundle_mismatch_and_stops() -> None:
    transport = _MapTransport({"index.html": b"alpha", "notes.txt": b"beta"})
    result = download_files(
        (
            FileRequest(path="index.html", content_sha256=_sha(b"other")),
            FileRequest(path="notes.txt", content_sha256=_sha(b"nope")),
        ),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == ["index.html"]


@pytest.mark.parametrize("digest", ["A" * 64, "ab", ""])
def test_malformed_hash_is_bundle_mismatch_before_open(digest: str) -> None:
    transport = _MapTransport({"ok.txt": b"alpha"})
    result = download_files((FileRequest(path="ok.txt", content_sha256=digest),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == []


def test_sixty_five_files_is_bundle_file_count_before_open() -> None:
    files = tuple(FileRequest(path=f"f{index}.txt") for index in range(65))
    transport = _MapTransport({item.path: b"x" for item in files})
    result = download_files(files, transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_file_count"
    assert transport.opened == []


def test_sixty_five_files_with_a_bad_path_is_still_file_count() -> None:
    transport = _MapTransport({})
    files = tuple(FileRequest(path=f"f{index}.txt") for index in range(64))
    files = (*files, FileRequest(path="../secret"))
    result = download_files(files, transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_file_count"
    assert transport.opened == []


def test_sixty_four_files_are_accepted() -> None:
    bodies = {f"f{index}.txt": b"x" for index in range(64)}
    transport = _MapTransport(bodies)
    files = tuple(FileRequest(path=path, content_sha256=_sha(b"x")) for path in bodies)
    result = download_files(files, transport)
    assert isinstance(result, DownloadOk)
    assert len(result.files) == 64
    assert transport.opened == list(bodies)


@pytest.mark.parametrize(
    "path",
    ["../x", "foo/../../etc", "foo..bar", "/abs", "a\\b", "", "p" * 513],
)
def test_illegal_path_is_bundle_path_before_open(path: str) -> None:
    transport = _MapTransport({path: b"alpha"})
    result = download_files((FileRequest(path=path),), transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_path"
    assert transport.opened == []


def test_bad_path_wins_over_a_bad_hash() -> None:
    transport = _MapTransport({"ok.txt": b"alpha"})
    result = download_files(
        (
            FileRequest(path="ok.txt", content_sha256="ZZ"),
            FileRequest(path="../nope"),
        ),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_path"
    assert transport.opened == []


def test_path_of_512_characters_is_accepted() -> None:
    path = "a" * 512
    body = b"ok"
    transport = _MapTransport({path: body})
    result = download_files((FileRequest(path=path, content_sha256=_sha(body)),), transport)
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == body


def test_dot_slash_segment_is_kept() -> None:
    body = b"ok"
    transport = _MapTransport({"foo/./bar.txt": body})
    result = download_files(
        (FileRequest(path="foo/./bar.txt", content_sha256=_sha(body)),),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert result.files[0].path == "foo/./bar.txt"


def test_one_byte_over_file_cap_is_bundle_too_large() -> None:
    payload = b"x" * (_FILE_CAP + 1 + 100)
    transport = _MapTransport({"index.html": payload})
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(b"other")),),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_too_large"
    assert transport.opened == ["index.html"]
    assert transport.cursors[0].pulled == _FILE_CAP + 1


def test_exact_file_cap_is_accepted() -> None:
    payload = b"y" * _FILE_CAP
    transport = _MapTransport({"index.html": payload})
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(payload)),),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == payload
    assert transport.cursors[0].pulled == _FILE_CAP


def test_exact_total_is_accepted_and_one_more_byte_is_bundle_too_large() -> None:
    chunk = b"z" * _FILE_CAP
    names = [f"part-{index}.bin" for index in range(5)]
    transport = _MapTransport({name: chunk for name in names})
    result = download_files(
        tuple(FileRequest(path=name, content_sha256=_sha(chunk)) for name in names),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert sum(len(item.body) for item in result.files) == _TOTAL_CAP

    extra = _MapTransport({**{name: chunk for name in names}, "extra.bin": b"!"})
    over = download_files(
        (
            *tuple(FileRequest(path=name, content_sha256=_sha(chunk)) for name in names),
            FileRequest(path="extra.bin", content_sha256=_sha(b"!")),
        ),
        extra,
    )
    assert isinstance(over, DownloadFailure)
    assert over.code == "bundle_too_large"
    assert extra.opened == [*names, "extra.bin"]
    assert extra.cursors[-1].pulled == 1
