from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from categorizer.extract import (
    ExtractFailure,
    ExtractOk,
    Meta,
    extract_bundle,
    stage_files,
)
from categorizer.fetch import DownloadedFile

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
    second = extract_bundle(_files(DownloadedFile(path="zap.png", body=_png(64, 32))), _meta(), tmp_root=tmp_path)
    assert isinstance(first, ExtractOk)
    assert isinstance(second, ExtractOk)
    assert first.extract == second.extract
    assert len(first.extract.haiku_text) <= _HAIKU_BUDGET
    assert len(first.extract.jev_text) <= _JEV_BUDGET
    assert len(first.extract.comments) == 1
    assert len(first.extract.images) == 1
    assert {item.path for item in first.extract.manifest} == {
        "app.js",
        "data.json",
        "index.html",
        "notes.txt",
        "zap.png",
    }


def test_budgets_truncate_at_exact_limits(tmp_path: Path) -> None:
    html = ("<html><body><p>" + "z" * 40_000 + "</p></body></html>").encode()
    files = [DownloadedFile(path="index.html", body=html)]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert len(result.extract.haiku_text) == _HAIKU_BUDGET
    assert len(result.extract.jev_text) == _JEV_BUDGET


def test_text_order_is_meta_then_html_then_js(tmp_path: Path) -> None:
    html = b"<html><body><p>ZZHTMLMARKERZZ</p></body></html>"
    js = b'const s = "ZZJSMARKERZZ";'
    files = [
        DownloadedFile(path="index.html", body=html),
        DownloadedFile(path="app.js", body=js),
    ]
    result = extract_bundle(files, _meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    text = result.extract.jev_text
    assert text.index("Game Title") < text.index("Tag Line") < text.index("Desc Words")
    assert text.index("Desc Words") < text.index("ZZHTMLMARKERZZ")
    assert text.index("ZZHTMLMARKERZZ") < text.index("ZZJSMARKERZZ")


def test_js_strings_fill_room_after_html_text(tmp_path: Path) -> None:
    html = ("<html><body><p>" + "h" * 4000 + "</p></body></html>").encode()
    js = b'const s = "ZZJSMARKERZZ";'
    files = [
        DownloadedFile(path="index.html", body=html),
        DownloadedFile(path="app.js", body=js),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert "ZZJSMARKERZZ" in result.extract.jev_text


def test_comments_separate_and_script_style_dropped(tmp_path: Path) -> None:
    html = (
        b"<html><head><style>ZZSTYLEZZ</style></head><body>"
        b"<!--ZZCOMMENTZZ--><p>hello</p><script>ZZSCRIPTZZ</script></body></html>"
    )
    files = [DownloadedFile(path="index.html", body=html)]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert "ZZCOMMENTZZ" not in result.extract.haiku_text
    assert "ZZCOMMENTZZ" not in result.extract.jev_text
    assert any("ZZCOMMENTZZ" in comment for comment in result.extract.comments)
    assert "ZZSCRIPTZZ" not in result.extract.haiku_text
    assert "ZZSTYLEZZ" not in result.extract.haiku_text
    assert "hello" in result.extract.haiku_text


def test_no_javascript_runs_and_temp_dir_removed(tmp_path: Path) -> None:
    sentinels = (Path("/tmp/mg-js-pwned"), Path("/tmp/mg-inline-pwned"))
    for sentinel in sentinels:
        assert not sentinel.exists()
    result = extract_bundle(_files(), Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    for sentinel in sentinels:
        assert not sentinel.exists()
    assert list(tmp_path.iterdir()) == []


def test_temp_dir_removed_on_failure(tmp_path: Path) -> None:
    files = [DownloadedFile(path="../evil", body=b"x")]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "bundle_path"
    assert list(tmp_path.iterdir()) == []


def test_dotdot_path_is_bundle_path(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="a/../../escape.txt", body=b"x"),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractFailure)
    assert result.code == "bundle_path"


def test_symlink_escape_is_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    (work / "link").symlink_to(outside, target_is_directory=True)
    staged = stage_files(work, [DownloadedFile(path="link/evil.txt", body=b"x")])
    assert staged is False
    assert not (outside / "evil.txt").exists()


@pytest.mark.parametrize("path", ["/etc/passwd", "a\x00b", "..", ".", "a/../.."])
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


def test_image_downscaled_and_reencoded(tmp_path: Path) -> None:
    files = [
        DownloadedFile(path="index.html", body=b"<p>ok</p>"),
        DownloadedFile(path="big.png", body=_png(2000, 500)),
    ]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert len(result.extract.images) == 1
    image = Image.open(io.BytesIO(result.extract.images[0].png))
    assert image.format == "PNG"
    assert max(image.size) <= 1024
    assert image.size == (1024, 256)


def test_four_largest_images_kept(tmp_path: Path) -> None:
    files = [DownloadedFile(path="index.html", body=b"<p>ok</p>")]
    for index, size in enumerate((10, 20, 30, 40, 50, 60)):
        files.append(DownloadedFile(path=f"img{index}.png", body=_png(size, size)))
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert [image.path for image in result.extract.images] == [
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
    assert isinstance(result, ExtractOk)
    assert [image.path for image in result.extract.images] == ["ok.png"]


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
    assert isinstance(result, ExtractOk)
    assert "ZZBEYONDZZ" not in result.extract.haiku_text


def test_binary_asset_is_manifest_only(tmp_path: Path) -> None:
    files = [DownloadedFile(path="sfx.wav", body=b"RIFF" + b"\x00" * 100)]
    result = extract_bundle(files, Meta(), tmp_root=tmp_path)
    assert isinstance(result, ExtractOk)
    assert result.extract.haiku_text == ""
    assert [(item.path, item.size) for item in result.extract.manifest] == [("sfx.wav", 104)]
