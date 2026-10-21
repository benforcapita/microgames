from __future__ import annotations

import hashlib

import pytest

from categorizer.fetch import (
    DownloadFailure,
    DownloadOk,
    FileRequest,
    download_files,
)

_TOTAL = 4 * 1024 * 1024
_MAX_FILES = 200


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


def test_matching_bundle_hash_keeps_index_html() -> None:
    body = b"alpha"
    transport = _MapTransport({"index.html": body, "notes.txt": b"beta"})
    result = download_files(
        (
            FileRequest(path="index.html"),
            FileRequest(path="notes.txt"),
        ),
        transport,
        bundle_sha256=_sha(body),
    )
    assert isinstance(result, DownloadOk)
    assert [(item.path, item.body) for item in result.files] == [
        ("index.html", body),
        ("notes.txt", b"beta"),
    ]


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


def _flip_last_hex(digest: str) -> str:
    return digest[:-1] + ("0" if digest[-1] != "0" else "1")


def test_content_hash_last_hex_character_is_bundle_mismatch_and_stops() -> None:
    first = b"alpha"
    second = b"beta"
    actual = _sha(first)
    expected = _flip_last_hex(actual)
    assert expected[:8] == actual[:8]
    assert expected[-1] != actual[-1]
    transport = _MapTransport({"index.html": first, "notes.txt": second})
    result = download_files(
        (
            FileRequest(path="index.html", content_sha256=expected),
            FileRequest(path="notes.txt", content_sha256=_sha(second)),
        ),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == ["index.html"]
    assert [cursor.pulled for cursor in transport.cursors] == [len(first)]


def test_bundle_hash_mismatch_is_bundle_mismatch_and_stops() -> None:
    transport = _MapTransport({"index.html": b"alpha", "notes.txt": b"beta"})
    result = download_files(
        (
            FileRequest(path="index.html"),
            FileRequest(path="notes.txt"),
        ),
        transport,
        bundle_sha256=_sha(b"other"),
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == ["index.html"]


def test_bundle_hash_last_hex_character_is_bundle_mismatch() -> None:
    body = b"alpha"
    actual = _sha(body)
    expected = _flip_last_hex(actual)
    assert expected[:8] == actual[:8]
    assert expected[-1] != actual[-1]
    transport = _MapTransport({"index.html": body, "notes.txt": b"beta"})
    result = download_files(
        (
            FileRequest(path="index.html"),
            FileRequest(path="notes.txt"),
        ),
        transport,
        bundle_sha256=expected,
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


def test_hash_with_trailing_newline_is_bundle_mismatch_before_open() -> None:
    body = b"alpha"
    transport = _MapTransport({"index.html": body, "notes.txt": b"beta"})
    result = download_files(
        (
            FileRequest(path="index.html", content_sha256=_sha(body) + "\n"),
            FileRequest(path="notes.txt", content_sha256=_sha(b"beta")),
        ),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == []
    assert transport.cursors == []


@pytest.mark.parametrize("digest", ["A" * 64, "ab", ""])
def test_malformed_bundle_hash_is_bundle_mismatch_before_open(digest: str) -> None:
    transport = _MapTransport({"index.html": b"alpha"})
    result = download_files(
        (FileRequest(path="index.html"),),
        transport,
        bundle_sha256=digest,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == []


def test_bundle_hash_without_index_html_is_bundle_mismatch_before_open() -> None:
    transport = _MapTransport({"notes.txt": b"beta"})
    result = download_files(
        (FileRequest(path="notes.txt"),),
        transport,
        bundle_sha256=_sha(b"beta"),
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_mismatch"
    assert transport.opened == []


def test_two_hundred_one_files_is_bundle_file_count_before_open() -> None:
    files = tuple(FileRequest(path=f"f{index}.txt") for index in range(_MAX_FILES + 1))
    transport = _MapTransport({item.path: b"x" for item in files})
    result = download_files(files, transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_file_count"
    assert transport.opened == []


def test_two_hundred_one_files_with_a_bad_path_is_still_file_count() -> None:
    transport = _MapTransport({})
    files = tuple(FileRequest(path=f"f{index}.txt") for index in range(_MAX_FILES))
    files = (*files, FileRequest(path="../secret"))
    result = download_files(files, transport)
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_file_count"
    assert transport.opened == []


def test_two_hundred_files_are_accepted() -> None:
    bodies = {f"f{index}.txt": b"x" for index in range(_MAX_FILES)}
    transport = _MapTransport(bodies)
    files = tuple(FileRequest(path=path, content_sha256=_sha(b"x")) for path in bodies)
    result = download_files(files, transport)
    assert isinstance(result, DownloadOk)
    assert len(result.files) == _MAX_FILES
    assert transport.opened == list(bodies)


@pytest.mark.parametrize(
    "path",
    ["../x", "foo/../../etc", "foo..bar", "/abs", "a\\b", "", "a\x00b", "p" * 513],
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


def test_exact_four_mib_is_accepted() -> None:
    payload = b"y" * _TOTAL
    transport = _MapTransport({"index.html": payload})
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(payload)),),
        transport,
        bundle_sha256=_sha(payload),
    )
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == payload
    assert transport.cursors[0].pulled == _TOTAL


def test_one_byte_over_four_mib_is_bundle_too_large() -> None:
    payload = b"x" * (_TOTAL + 1)
    transport = _MapTransport({"index.html": payload})
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(payload)),),
        transport,
        bundle_sha256=_sha(payload),
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_too_large"
    assert transport.opened == ["index.html"]
    assert transport.cursors[0].pulled == _TOTAL + 1


def test_two_files_that_sum_over_the_total_are_bundle_too_large() -> None:
    first = b"a" * (_TOTAL // 2 + 1)
    second = b"b" * (_TOTAL // 2 + 1)
    transport = _MapTransport({"a.bin": first, "b.bin": second})
    result = download_files(
        (
            FileRequest(path="a.bin", content_sha256=_sha(first)),
            FileRequest(path="b.bin", content_sha256=_sha(second)),
        ),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "bundle_too_large"
    assert transport.opened == ["a.bin", "b.bin"]
    assert transport.cursors[1].pulled == _TOTAL - len(first) + 1


class _StatusCursor(_Cursor):
    def __init__(self, data: bytes, status: object) -> None:
        super().__init__(data)
        self.status = status


class _StatusTransport(_MapTransport):
    def __init__(self, files: dict[str, bytes], status: object) -> None:
        super().__init__(files)
        self._status = status

    def open(self, path: str) -> _StatusCursor:
        self.opened.append(path)
        cursor = _StatusCursor(self._files[path], self._status)
        self.cursors.append(cursor)
        return cursor


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (100, "fetch_4xx"),
        (150, "fetch_4xx"),
        (199, "fetch_4xx"),
        (301, "fetch_4xx"),
        (302, "fetch_4xx"),
        (307, "fetch_4xx"),
        (400, "fetch_4xx"),
        (404, "fetch_4xx"),
        (499, "fetch_4xx"),
        (500, "fetch_5xx"),
        (502, "fetch_5xx"),
        (401, "fetch_unauthorized"),
        (403, "fetch_unauthorized"),
    ],
)
def test_source_status_maps_before_hashing(status: int, code: str) -> None:
    body = b"alpha"
    transport = _StatusTransport({"index.html": body}, status)
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(b"other")),),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == code
    assert result.code != "bundle_mismatch"
    assert [cursor.pulled for cursor in transport.cursors] == [0]


def test_status_200_on_fake_source_still_downloads() -> None:
    body = b"alpha"
    transport = _StatusTransport({"index.html": body}, 200)
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(body)),),
        transport,
    )
    assert isinstance(result, DownloadOk)
    assert result.files[0].body == body


@pytest.mark.parametrize("status", ["200", 200.0, None, True])
def test_non_integer_status_is_fetch_5xx(status: object) -> None:
    body = b"alpha"
    transport = _StatusTransport({"index.html": body}, status)
    result = download_files(
        (FileRequest(path="index.html", content_sha256=_sha(body)),),
        transport,
    )
    assert isinstance(result, DownloadFailure)
    assert result.code == "fetch_5xx"
    assert [cursor.pulled for cursor in transport.cursors] == [0]
