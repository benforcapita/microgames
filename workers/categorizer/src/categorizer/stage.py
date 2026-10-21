from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path

from categorizer.fetch import DownloadedFile


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


__all__ = ("stage_files",)
