from __future__ import annotations

from pathlib import Path

import pytest

from categorizer.fetch import DownloadedFile
from categorizer.stage import stage_files


def test_dotdot_path_is_rejected(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    staged = stage_files(work, [DownloadedFile(path="a/../../escape.txt", body=b"x")])
    assert staged is False
    assert not (tmp_path / "escape.txt").exists()


def test_symlink_escape_is_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    (work / "link").symlink_to(outside, target_is_directory=True)
    staged = stage_files(work, [DownloadedFile(path="link/evil.txt", body=b"x")])
    assert staged is False
    assert not (outside / "evil.txt").exists()


@pytest.mark.parametrize("path", ["/etc/passwd", "a\x00b", "..", ".", "a/../..", ""])
def test_stage_files_rejects_unsafe_paths(tmp_path: Path, path: str) -> None:
    work = tmp_path / "work"
    work.mkdir()
    assert stage_files(work, [DownloadedFile(path=path, body=b"x")]) is False


def test_stage_files_writes_nested_paths(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    staged = stage_files(
        work, [DownloadedFile(path="a/b/c.txt", body=b"deep"), DownloadedFile(path="top.txt", body=b"t")]
    )
    assert staged is True
    assert (work / "a" / "b" / "c.txt").read_bytes() == b"deep"
    assert (work / "top.txt").read_bytes() == b"t"


def test_path_resolving_to_root_file_is_rejected(tmp_path: Path) -> None:
    target = tmp_path / "bundle.txt"
    target.write_bytes(b"keep")
    assert stage_files(target, [DownloadedFile(path=".", body=b"new")]) is False
    assert target.read_bytes() == b"keep"
