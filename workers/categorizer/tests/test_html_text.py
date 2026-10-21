from __future__ import annotations

from categorizer.extract import parse_html


def test_title_meta_attributes_and_visible_text() -> None:
    html = (
        "<html><head><title>My Game</title>"
        '<meta name="description" content="A fun game."></head>'
        "<body><h1>Heading</h1><p>Some visible text.</p>"
        '<img src="i.png" alt="alt words" title="title words">'
        '<button aria-label="aria words">Go</button></body></html>'
    )
    parsed = parse_html(html)
    for needle in (
        "My Game",
        "A fun game.",
        "alt words",
        "title words",
        "aria words",
        "Heading",
        "Some visible text.",
    ):
        assert needle in parsed[0]
    assert parsed[1] == ()


def test_script_and_style_bodies_dropped() -> None:
    html = (
        "<html><head><style>.x{color:red}</style><script>var a=1;</script></head>"
        "<body><p>keep me</p><script>var b=2;</script></body></html>"
    )
    parsed = parse_html(html)
    assert "var a=1" not in parsed[0]
    assert "var b=2" not in parsed[0]
    assert ".x{color:red}" not in parsed[0]
    assert "keep me" in parsed[0]


def test_style_inside_body_is_dropped() -> None:
    html = "<html><body><style>.sel{STYLETEXT}</style><p>keep</p></body></html>"
    parsed = parse_html(html)
    assert "STYLETEXT" not in parsed[0]
    assert "keep" in parsed[0]


def test_comments_captured_separately() -> None:
    html = "<html><body><!--first note--><p>x</p><!-- second --></body></html>"
    parsed = parse_html(html)
    assert "first note" not in parsed[0]
    assert "second" not in parsed[0]
    assert len(parsed[1]) == 2
    assert "first note" in parsed[1][0]
    assert "second" in parsed[1][1]


def test_empty_and_malformed_html() -> None:
    assert parse_html("")[0] == ""
    assert parse_html("")[1] == ()
    parsed = parse_html("<p>unclosed")
    assert "unclosed" in parsed[0]
