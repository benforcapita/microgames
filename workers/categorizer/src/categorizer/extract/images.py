from __future__ import annotations

import warnings
from io import BytesIO

from PIL import Image

from categorizer.extract.sandbox import ExtractFailed

_MAX_SIDE = 1024
Image.MAX_IMAGE_PIXELS = 40_000_000


def encode_png(body: bytes) -> bytes:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            image = Image.open(BytesIO(body))
            image.load()
            image.thumbnail((_MAX_SIDE, _MAX_SIDE))
            image = image.convert("RGBA")
            out = BytesIO()
            image.save(out, "PNG")
            return out.getvalue()
        except MemoryError:
            raise
        except Exception as err:
            raise ExtractFailed("extract_image") from err


__all__ = ("encode_png",)
