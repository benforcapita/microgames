from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import NamedTuple

from categorizer.extract.html_text import parse_html
from categorizer.extract.images import encode_png
from categorizer.extract.js_strings import tokenize
from categorizer.extract.sandbox import DEFAULT_LIMITS, Limits, SandboxOk, run_sandboxed
from categorizer.fetch import DownloadedFile

_HAIKU_BUDGET = 24_000
_JEV_BUDGET = 8_000
_TEXT_BYTES = 4 * 1024
_MAX_IMAGES = 4
_MAX_JS_STRINGS = 400
_TARGET = "categorizer.extract.bundle:build"
_EXT = {
    "html": frozenset({"htm", "html"}),
    "js": frozenset({"js", "mjs"}),
    "text": frozenset({"json", "md", "txt"}),
    "image": frozenset({"bmp", "gif", "jpeg", "jpg", "png", "webp"}),
}


class Meta(NamedTuple):
    title: str = ""
    tagline: str = ""
    description: str = ""


class Asset(NamedTuple):
    path: str
    size: int


class ExtractImage(NamedTuple):
    path: str
    png: bytes


class Extract(NamedTuple):
    haiku_text: str
    jev_text: str
    comments: tuple[str, ...]
    images: tuple[ExtractImage, ...]
    manifest: tuple[Asset, ...]


class ExtractOk(NamedTuple):
    extract: Extract


class ExtractFailure(NamedTuple):
    code: str


def extract_bundle(
    files: Sequence[DownloadedFile],
    meta: Meta,
    *,
    tmp_root: Path | None = None,
    limits: Limits = DEFAULT_LIMITS,
    target: str = _TARGET,
) -> ExtractOk | ExtractFailure:
    work = Path(tempfile.mkdtemp(prefix="mgx-", dir=tmp_root))
    try:
        if not stage_files(work, files):
            return ExtractFailure(code="bundle_path")
        outcome = run_sandboxed(work, target, meta, limits=limits)
        if isinstance(outcome, SandboxOk):
            if isinstance(outcome.value, Extract):
                return ExtractOk(extract=outcome.value)
            return ExtractFailure(code="extract_crash")
        return ExtractFailure(code=outcome.code)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def stage_files(root: Path, files: Sequence[DownloadedFile]) -> bool:
    base = Path(os.path.realpath(root))
    for item in files:
        if not item.path or "\x00" in item.path:
            return False
        dest = Path(os.path.realpath(base / item.path))
        if dest == base or not dest.is_relative_to(base):
            return False
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(item.body)
        except OSError:
            return False
    return True


def build(work_dir: Path, meta: Meta) -> Extract:
    text_parts: list[str] = []
    js_strings: dict[str, None] = {}
    comments: list[str] = []
    candidates: list[tuple[int, str, bytes]] = []
    manifest: list[Asset] = []
    for path in sorted(p for p in work_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(work_dir).as_posix()
        body = path.read_bytes()
        manifest.append(Asset(path=rel, size=len(body)))
        kind = _kind(rel)
        if kind == "html":
            parsed = parse_html(body.decode("utf-8", errors="replace"))
            comments.extend(parsed.comments)
            text_parts.append(parsed.text)
        elif kind == "js":
            for string in tokenize(body.decode("utf-8", errors="replace")):
                js_strings.setdefault(string)
        elif kind == "text":
            text_parts.append(body[:_TEXT_BYTES].decode("utf-8", errors="replace"))
        elif kind == "image":
            candidates.append((len(body), rel, body))
    chosen = sorted(candidates, key=lambda item: (-item[0], item[1]))[:_MAX_IMAGES]
    images = tuple(
        ExtractImage(path=rel, png=encode_png(body))
        for _size, rel, body in sorted(chosen, key=lambda item: item[1])
    )
    parts = [part for part in (meta.title, meta.tagline, meta.description) if part]
    parts += [part for part in text_parts if part]
    parts += list(js_strings)[:_MAX_JS_STRINGS]
    full = "\n".join(parts)
    return Extract(
        haiku_text=full[:_HAIKU_BUDGET],
        jev_text=full[:_JEV_BUDGET],
        comments=tuple(comments),
        images=images,
        manifest=tuple(manifest),
    )


def _kind(path: str) -> str:
    suffix = path.rpartition(".")[2].lower() if "." in path else ""
    for kind, extensions in _EXT.items():
        if suffix in extensions:
            return kind
    return "binary"


__all__ = (
    "Asset",
    "Extract",
    "ExtractFailure",
    "ExtractImage",
    "ExtractOk",
    "Meta",
    "build",
    "extract_bundle",
    "stage_files",
)
