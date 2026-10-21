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


def test_sibling_prefix_symlink_escape_is_rejected(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    sibling = tmp_path / "work2"
    sibling.mkdir()
    (work / "link").symlink_to(sibling, target_is_directory=True)
    staged = stage_files(work, [DownloadedFile(path="link/pwn.txt", body=b"x")])
    assert staged is False
    assert not (sibling / "pwn.txt").exists()


def test_file_then_dir_conflict_returns_false(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    staged = stage_files(
        work,
        [DownloadedFile(path="a", body=b"x"), DownloadedFile(path="a/b", body=b"y")],
    )
    assert staged is False
    assert (work / "a").is_file()


def test_dir_then_file_conflict_returns_false(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    staged = stage_files(
        work,
        [DownloadedFile(path="a/b", body=b"y"), DownloadedFile(path="a", body=b"x")],
    )
    assert staged is False
    assert (work / "a" / "b").read_bytes() == b"y"


def test_symlinked_root_stages_inside_target(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "linkroot"
    link.symlink_to(real, target_is_directory=True)
    staged = stage_files(link, [DownloadedFile(path="a.txt", body=b"x")])
    assert staged is True
    assert (real / "a.txt").read_bytes() == b"x"


def test_dotdot_through_missing_dir_writes_inside(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    staged = stage_files(work, [DownloadedFile(path="nx/../y.txt", body=b"x")])
    assert staged is True
    assert (work / "y.txt").read_bytes() == b"x"
