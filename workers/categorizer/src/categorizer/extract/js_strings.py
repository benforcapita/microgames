from __future__ import annotations

_MIN_LEN = 3
_MAX_LEN = 200
_QUOTES = "'\"`"


def tokenize(source: str) -> tuple[str, ...]:
    found: dict[str, None] = {}
    index = 0
    end = len(source)
    while index < end:
        char = source[index]
        if char == "/" and index + 1 < end and source[index + 1] == "/":
            newline = source.find("\n", index + 2)
            index = end if newline < 0 else newline + 1
        elif char == "/" and index + 1 < end and source[index + 1] == "*":
            close = source.find("*/", index + 2)
            index = end if close < 0 else close + 2
        elif char in _QUOTES:
            literal, index = _literal(source, index)
            if literal is not None and _MIN_LEN <= len(literal) <= _MAX_LEN:
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
            chars.append(char)
            chars.append(source[index + 1])
            index += 2
        elif char == quote:
            return "".join(chars), index + 1
        elif char == "\n" and quote != "`":
            return None, index
        else:
            chars.append(char)
            index += 1
    return None, index


__all__ = ("tokenize",)
