from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple

from categorizer.extract.html_text import parse_html
from categorizer.extract.images import encode_png
from categorizer.extract.js_strings import tokenize
from categorizer.extract.sandbox import (
    DEFAULT_LIMITS,
    ExtractFailed,
    Limits,
    run_sandboxed,
)
from categorizer.fetch import DownloadedFile
from categorizer.stage import stage_files

_HAIKU_BUDGET = 24_000
_JEV_BUDGET = 8_000
_TEXT_BYTES = 4 * 1024
_MAX_IMAGES = 4
_MAX_JS_STRINGS = 400
_KIND = (
    dict.fromkeys(("htm", "html"), "html")
    | dict.fromkeys(("js", "mjs"), "js")
    | dict.fromkeys(("json", "md", "txt"), "text")
    | dict.fromkeys(("bmp", "gif", "jpeg", "jpg", "png", "webp"), "image")
)


class Meta(NamedTuple):
    title: str = ""
    tagline: str = ""
    description: str = ""


class Extract(NamedTuple):
    haiku_text: str
    jev_text: str
    comments: tuple[str, ...]
    images: tuple[tuple[str, bytes], ...]
    manifest: tuple[tuple[str, int], ...]


class ExtractFailure(NamedTuple):
    code: str


def build(work_dir: Path, payload: object) -> Extract:
    if not isinstance(payload, Meta):
        raise ExtractFailed("extract_crash")
    text = [part for part in (payload.title, payload.tagline, payload.description) if part]
    js_strings: dict[str, None] = {}
    comments: list[str] = []
    candidates: list[tuple[int, str, bytes]] = []
    manifest: list[tuple[str, int]] = []
    for path in sorted(p for p in work_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(work_dir).as_posix()
        body = path.read_bytes()
        manifest.append((rel, len(body)))
        kind = _KIND.get(rel.rpartition(".")[2].lower())
        if kind == "html":
            parsed = parse_html(body.decode("utf-8", errors="replace"))
            comments.extend(parsed.comments)
            text.append(parsed.text)
        elif kind == "js":
            for string in tokenize(body.decode("utf-8", errors="replace")):
                js_strings.setdefault(string)
        elif kind == "text":
            text.append(body[:_TEXT_BYTES].decode("utf-8", errors="replace"))
        elif kind == "image":
            candidates.append((len(body), rel, body))
    chosen = sorted(candidates, key=lambda item: (-item[0], item[1]))[:_MAX_IMAGES]
    text += list(js_strings)[:_MAX_JS_STRINGS]
    full = "\n".join(part for part in text if part)
    return Extract(
        haiku_text=full[:_HAIKU_BUDGET],
        jev_text=full[:_JEV_BUDGET],
        comments=tuple(comments),
        images=tuple(
            (rel, encode_png(body))
            for _size, rel, body in sorted(chosen, key=lambda item: item[1])
        ),
        manifest=tuple(manifest),
    )


def extract_bundle(
    files: Sequence[DownloadedFile],
    meta: Meta,
    *,
    tmp_root: Path | None = None,
    limits: Limits = DEFAULT_LIMITS,
    fn: Callable[[Path, object], object] = build,
) -> Extract | ExtractFailure:
    work = Path(tempfile.mkdtemp(prefix="mgx-", dir=tmp_root))
    try:
        if not stage_files(work, files):
            return ExtractFailure(code="bundle_path")
        outcome = run_sandboxed(work, fn, meta, limits=limits)
        if outcome.code is not None:
            return ExtractFailure(code=outcome.code)
        if not isinstance(outcome.value, Extract):
            return ExtractFailure(code="extract_crash")
        return outcome.value
    finally:
        shutil.rmtree(work, ignore_errors=True)
