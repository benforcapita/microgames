from __future__ import annotations

import io
import os
import stat
import tempfile
from collections.abc import Sequence
from pathlib import Path

import pytest
from PIL import Image

import support
from categorizer import extract as bundle_mod
from categorizer.extract import Extract, ExtractFailure, Limits, Meta, extract_bundle
from categorizer.fetch import DownloadedFile
from categorizer.stage import stage_files

_FIXTURE = Path(__file__).parent / "fixtures" / "basic"
_HAIKU_BUDGET = 24_000
_JEV_BUDGET = 8_000


def _png(width: int, height: int, color: tuple[int, int, int] = (10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


def _files(*extra: DownloadedFile) -> list[DownloadedFile]:
    files = [
        DownloadedFile(path=path.name, body=path.read_bytes())
        for path in sorted(_FIXTURE.iterdir())
    ]
    return [*files, *extra]


def _meta() -> Meta:
    return Meta(title="Game Title", tagline="Tag Line", description="Desc Words")


def test_fixture_extract_is_deterministic_and_within_budgets(tmp_path: Path) -> None:
    files = _files(DownloadedFile(path="zap.png", body=_png(64, 32)))
    first = extract_bundle(files, _meta(), tmp_root=tmp_path)
    second = extract_bundle(
        _files(DownloadedFile(path="zap.png", body=_png(64, 32))), _meta(), tmp_root=tmp_path
    )
    assert isinstance(first, Extract)
    assert isinstance(second, Extract)
    assert first == second
    assert len(first.haiku_text) <= _HAIKU_BUDGET
    assert len(first.jev_text) <= _JEV_BUDGET
    assert len(first.comments) == 1
    assert len(first.images) == 1
    assert {item[0] for item in first.manifest} == {
        "app.js",
        "data.json",
        "index.html",
        "notes.txt",
        "zap.png",
    }


def test_budgets_truncate_at_exact_limits(tmp_path: Path) -> None:
    html = ("<html><body><p>" + "z" * 40_000 + "</p></body></html>").encode()
    result = extract_bundle([DownloadedFile(path="index.html", body=html)], Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert len(result.haiku_text) == _HAIKU_BUDGET
    assert len(result.jev_text) == _JEV_BUDGET


def test_text_order_is_meta_then_html_then_js(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<html><body><p>ZZHTMLMARKERZZ</p></body></html>"),
        DownloadedFile(path="app.js", body=b'const s = "ZZJSMARKERZZ";'),
    ]
    result = extract_bundle(files, _meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    text = result.jev_text
    assert text.index("Game Title") < text.index("Tag Line") < text.index("Desc Words")
    assert text.index("Desc Words") < text.index("ZZHTMLMARKERZZ")
    assert text.index("ZZHTMLMARKERZZ") < text.index("ZZJSMARKERZZ")


def test_js_strings_fill_room_after_html_text(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=("<p>" + "h" * 4000 + "</p>").encode()),
        DownloadedFile(path="app.js", body=b'const s = "ZZJSMARKERZZ";'),
    ]
    result = extract_bundle(files, _meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert "ZZJSMARKERZZ" in result.jev_text


def test_comments_separate_and_script_style_dropped(tmp_path: Path) -> None:
    html = (
        b"<html><head><style>ZZSTYLEZZ</style></head><body>"
        b"<!--ZZCOMMENTZZ--><p>hello</p><script>ZZSCRIPTZZ</script></body></html>"
    )
    result = extract_bundle([DownloadedFile(path="index.html", body=html)], Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert "ZZCOMMENTZZ" not in result.haiku_text
    assert "ZZCOMMENTZZ" not in result.jev_text
    assert any("ZZCOMMENTZZ" in comment for comment in result.comments)
    assert "ZZSCRIPTZZ" not in result.haiku_text
    assert "ZZSTYLEZZ" not in result.haiku_text
    assert "hello" in result.haiku_text


def test_no_javascript_runs_and_temp_dir_removed(tmp_path: Path) -> None:
    sentinels = (Path("/tmp/mg-js-pwned"), Path("/tmp/mg-inline-pwned"))
    for sentinel in sentinels:
        assert not sentinel.exists()
    result = extract_bundle(_files(), Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    for sentinel in sentinels:
        assert not sentinel.exists()
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_is_private_and_removed_on_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    created: list[Path] = []
    modes: list[int] = []
    real_mkdtemp = tempfile.mkdtemp

    def spy(
        suffix: str | None = None,
        prefix: str | None = None,
        dir: str | None = None,
    ) -> str:
        path = real_mkdtemp(suffix=suffix, prefix=prefix, dir=dir)
        created.append(Path(path))
        modes.append(stat.S_IMODE(os.stat(path).st_mode))
        return path

    monkeypatch.setattr(tempfile, "mkdtemp", spy)
    result = extract_bundle(_files(), _meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert modes == [0o700]
    assert created and not created[0].exists()
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_removed_mid_batch_rejection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed: dict[str, bool] = {}
    real_stage = bundle_mod.stage_files

    def wrapped(root: Path, files: Sequence[DownloadedFile]) -> bool:
        ok = real_stage(root, files)
        observed["earlier_written"] = (root / "ok.txt").exists()
        return ok

    monkeypatch.setattr(bundle_mod, "stage_files", wrapped)
    files = [
        DownloadedFile(path="ok.txt", body=b"ok"),
        DownloadedFile(path="a/../../escape.txt", body=b"x"),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "bundle_path"
    assert observed["earlier_written"] is True
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_removed_after_limit_kill(tmp_path: Path) -> None:
    result = extract_bundle(
        _files(),
        Meta(),
        tmp_root=tmp_path,
        limits=Limits(cpu_seconds=1, wall_seconds=15.0),
        fn=support.burn_cpu,
    )
    assert isinstance(result, ExtractFailure)
    assert result.code == "extract_limit"
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_removed_after_crash(tmp_path: Path) -> None:
    result = extract_bundle(_files(), Meta(), tmp_root=tmp_path, fn=support.explode)
    assert isinstance(result, ExtractFailure)
    assert result.code == "extract_crash"
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_removed_after_image_error(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="huge.png", body=_png(8000, 7000)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "extract_image"
    assert list(tmp_path.iterdir()) == []


def test_dotdot_path_is_bundle_path(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="a/../../escape.txt", body=b"x"),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "bundle_path"


def test_extract_uses_stage_files(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    assert stage_files(work, [DownloadedFile(path="a/b.txt", body=b"deep")])
    assert (work / "a" / "b.txt").read_bytes() == b"deep"


def test_image_downscaled_and_reencoded(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="big.png", body=_png(2000, 500)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert len(result.images) == 1
    image = Image.open(io.BytesIO(result.images[0][1]))
    assert image.format == "PNG"
    assert image.size == (1024, 256)


def test_four_largest_images_kept(tmp_path: Path) -> None:
    files = [DownloadedFile(path="index.html", body=b"<p>ok</p>")]
    for index, size in enumerate((10, 20, 30, 40, 50, 60)):
        files.append(DownloadedFile(path=f"img{index}.png", body=_png(size, size)))
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert [image[0] for image in result.images] == [
        "img2.png",
        "img3.png",
        "img4.png",
        "img5.png",
    ]


def test_fifty_megapixel_image_is_extract_image(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="huge.png", body=_png(8000, 7000)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "extract_image"


def test_under_cap_image_is_kept(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="ok.png", body=_png(6000, 5000)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert [image[0] for image in result.images] == ["ok.png"]


def test_over_double_cap_image_is_extract_image(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="huge.png", body=_png(8000, 11_000)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "extract_image"


def test_text_asset_capped_at_four_kibibytes(tmp_path: Path) -> None:
    files = [DownloadedFile(path="notes.txt", body=b"a" * 4096 + b"ZZBEYONDZZ")]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert "ZZBEYONDZZ" not in result.haiku_text


def test_binary_asset_is_manifest_only(tmp_path: Path) -> None:
    files = [DownloadedFile(path="sfx.wav", body=b"RIFF" + b"\x00" * 100)]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, Extract)
    assert result.haiku_text == ""
    assert [item for item in result.manifest] == [("sfx.wav", 104)]
