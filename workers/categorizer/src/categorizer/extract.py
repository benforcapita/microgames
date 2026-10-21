from __future__ import annotations

import multiprocessing
import os
import pickle
import resource
import shutil
import signal
import socket
import tempfile
import warnings
from collections.abc import Callable, Sequence
from io import BytesIO
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import NamedTuple

from PIL import Image
from selectolax.lexbor import LexborHTMLParser

from categorizer.fetch import DownloadedFile
from categorizer.stage import stage_files

_HAIKU_BUDGET = 24_000
_JEV_BUDGET = 8_000
_MAX_JS_STRINGS = 400
_KIND = {
    "htm": "html", "html": "html", "js": "js", "mjs": "js",
    "json": "text", "md": "text", "txt": "text",
    "bmp": "image", "gif": "image", "jpeg": "image", "jpg": "image",
    "png": "image", "webp": "image",
}
Image.MAX_IMAGE_PIXELS = 40_000_000


class ExtractFailed(Exception):
    pass


class Limits(NamedTuple):
    as_bytes: int = 768 * 1024 * 1024
    cpu_seconds: int = 20
    open_files: int = 64
    wall_seconds: float = 60.0


DEFAULT_LIMITS = Limits()


class Outcome(NamedTuple):
    code: str | None
    value: object
    proc: BaseProcess


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


def run_sandboxed(
    work_dir: Path,
    fn: Callable[[Path, object], object],
    payload: object,
    *,
    limits: Limits = DEFAULT_LIMITS,
) -> Outcome:
    out = Path(str(work_dir) + ".result")
    ctx = multiprocessing.get_context("spawn")
    proc = ctx.Process(target=_entry, args=(str(work_dir), str(out), fn, payload, limits))
    proc.start()
    proc.join(limits.wall_seconds)
    if proc.is_alive():
        proc.kill()
        proc.join()
    try:
        message: object = pickle.loads(out.read_bytes()) if out.is_file() else None
    except Exception:
        message = None
    out.unlink(missing_ok=True)
    if isinstance(message, str):
        return Outcome(code=message, value=None, proc=proc)
    if message is not None:
        return Outcome(code=None, value=message, proc=proc)
    killed = proc.exitcode in (-signal.SIGKILL, -signal.SIGXCPU)
    return Outcome(code="extract_limit" if killed else "extract_crash", value=None, proc=proc)


def _entry(
    work_dir: str,
    out: str,
    fn: Callable[[Path, object], object],
    payload: object,
    limits: Limits,
) -> None:
    try:
        os.chdir(work_dir)
        socket.socket = socket.socketpair = _DeniedSocket
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds,) * 2)
        resource.setrlimit(resource.RLIMIT_AS, (limits.as_bytes,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (limits.open_files,) * 2)
        result: object = fn(Path(work_dir), payload)
    except ExtractFailed as err:
        result = err.args[0]
    except MemoryError:
        result = "extract_limit"
    except BaseException:
        result = "extract_crash"
    Path(out).write_bytes(pickle.dumps(result))


class _DeniedSocket(socket.socket):
    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise OSError("network disabled")


def parse_html(source: str) -> tuple[str, tuple[str, ...]]:
    tree = LexborHTMLParser(source)
    comments = tuple(
        node.comment_content for node in tree.root.traverse() if node.is_comment_node
    )
    for node in tree.css("script,style"):
        node.decompose()
    parts: list[str] = []
    if (title := tree.css_first("title")) is not None:
        parts.append(title.text())
    meta = tree.css_first('meta[name="description"]')
    if meta is not None and (content := meta.attributes.get("content")):
        parts.append(content)
    for node in tree.css("*"):
        parts.extend(
            value
            for name in ("alt", "title", "aria-label")
            if (value := node.attributes.get(name))
        )
    if tree.body is not None:
        parts.append(tree.body.text(separator=" ", strip=True))
    return "\n".join(part for part in parts if part), comments


def tokenize(source: str) -> tuple[str, ...]:
    found: dict[str, None] = {}
    index = 0
    end = len(source)
    while index < end:
        char = source[index]
        if char == "/" and index + 1 < end and source[index + 1] in "/*":
            mark = "\n" if source[index + 1] == "/" else "*/"
            hit = source.find(mark, index + 2)
            index = end if hit < 0 else hit + len(mark)
        elif char in "'\"`":
            literal, index = _literal(source, index)
            if literal is not None and 3 <= len(literal) <= 200:
                found.setdefault(literal)
        else:
            index += 1
    return tuple(found)


def _literal(source: str, start: int) -> tuple[str | None, int]:
    quote = source[start]
    index = start + 1
    end = len(source)
    chars: list[str] = []
    while index < end:
        char = source[index]
        if char == "\\" and index + 1 < end:
            chars.append(source[index : index + 2])
            index += 2
        elif char == quote:
            return "".join(chars), index + 1
        elif char == "\n" and quote != "`":
            return None, index
        else:
            chars.append(char)
            index += 1
    return None, index


def encode_png(body: bytes) -> bytes:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            image = Image.open(BytesIO(body))
            image.load()
            image.thumbnail((1024, 1024))
            image = image.convert("RGBA")
            out = BytesIO()
            image.save(out, "PNG")
            return out.getvalue()
        except MemoryError:
            raise
        except Exception as err:
            raise ExtractFailed("extract_image") from err


def build(work_dir: Path, payload: object) -> Extract:
    if not isinstance(payload, Meta):
        raise ExtractFailed("extract_crash")
    text = [part for part in (payload.title, payload.tagline, payload.description) if part]
    js: list[str] = []
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
            comments.extend(parsed[1])
            text.append(parsed[0])
        elif kind == "js":
            js += tokenize(body.decode("utf-8", errors="replace"))
        elif kind == "text":
            text.append(body[:4096].decode("utf-8", errors="replace"))
        elif kind == "image":
            candidates.append((len(body), rel, body))
    chosen = sorted(candidates, key=lambda item: (-item[0], item[1]))[:4]
    chosen.sort(key=lambda item: item[1])
    text += list(dict.fromkeys(js))[:_MAX_JS_STRINGS]
    full = "\n".join(part for part in text if part)
    return Extract(
        haiku_text=full[:_HAIKU_BUDGET],
        jev_text=full[:_JEV_BUDGET],
        comments=tuple(comments),
        images=tuple((rel, encode_png(body)) for _size, rel, body in chosen),
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
