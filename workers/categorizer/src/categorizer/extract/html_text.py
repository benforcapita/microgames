from __future__ import annotations

from typing import NamedTuple

from selectolax.lexbor import LexborHTMLParser

_ATTRS = ("alt", "title", "aria-label")


class HtmlText(NamedTuple):
    text: str
    comments: tuple[str, ...]


def parse_html(source: str) -> HtmlText:
    tree = LexborHTMLParser(source)
    comments = tuple(
        node.comment_content for node in tree.root.traverse() if node.is_comment_node
    )
    for node in tree.css("script,style"):
        node.decompose()
    parts: list[str] = []
    title = tree.css_first("title")
    if title is not None:
        parts.append(title.text())
    meta = tree.css_first('meta[name="description"]')
    if meta is not None:
        content = meta.attributes.get("content")
        if content:
            parts.append(content)
    for node in tree.css("*"):
        parts.extend(
            value for name in _ATTRS if (value := node.attributes.get(name))
        )
    if tree.body is not None:
        parts.append(tree.body.text(separator=" ", strip=True))
    return HtmlText(text="\n".join(part for part in parts if part), comments=comments)


__all__ = ("HtmlText", "parse_html")
