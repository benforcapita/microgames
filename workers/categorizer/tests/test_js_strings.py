from __future__ import annotations

from categorizer.extract import tokenize


def test_single_double_and_template_literals() -> None:
    source = "const a = 'alpha'; const b = \"beta\"; const c = `gamma ${x}`;"
    assert tokenize(source) == ("alpha", "beta", "gamma ${x}")


def test_short_and_long_literals_dropped() -> None:
    source = "const a = 'ab'; const b = 'abc'; const c = '" + "x" * 200 + "'; const d = '" + "y" * 201 + "';"
    assert tokenize(source) == ("abc", "x" * 200)


def test_duplicates_removed_keeping_order() -> None:
    source = "const a = 'one'; const b = 'two'; const c = 'one'; const d = 'two';"
    assert tokenize(source) == ("one", "two")


def test_line_and_block_comments_skipped() -> None:
    source = "// 'hidden one'\n/* \"hidden two\" */\nconst a = 'shown';"
    assert tokenize(source) == ("shown",)


def test_escaped_quote_does_not_end_literal() -> None:
    source = r"const a = 'it\'s fine'; const b = 'next';"
    assert tokenize(source) == (r"it\'s fine", "next")


def test_unterminated_literal_stops_at_newline() -> None:
    source = "const a = 'oops\nconst b = 'fine';"
    assert tokenize(source) == ("fine",)


def test_template_literal_spans_newlines() -> None:
    source = "const t = `line one\nline two`;"
    assert tokenize(source) == ("line one\nline two",)


def test_empty_source() -> None:
    assert tokenize("") == ()


def test_strings_inside_code_not_strings_outside() -> None:
    source = "require('fs').writeFileSync('/tmp/x', 'payload text');"
    assert tokenize(source) == ("/tmp/x", "payload text")
