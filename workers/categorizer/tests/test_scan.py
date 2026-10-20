from __future__ import annotations

import io
from pathlib import Path

from categorizer import scan_repo

REPO = Path(__file__).resolve().parents[3]


def test_ci_runs_lint_tests_and_secret_scan() -> None:
    text = (REPO / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert "working-directory: workers/categorizer" in text
    assert "uv run ruff check ." in text
    assert "uv run pytest" in text
    assert "scan_repo" in text


def test_package_scan_is_clean() -> None:
    buf = io.StringIO()
    assert scan_repo(stream=buf) == 0
    assert buf.getvalue() == ""


def test_scan_reports_a_private_key_without_printing_it(tmp_path: Path) -> None:
    marker = "-----BEGIN " + "RSA PRIVATE KEY-----"
    (tmp_path / "note.txt").write_text(marker + "\n", encoding="utf-8")
    buf = io.StringIO()
    assert scan_repo(tmp_path, buf) == 1
    output = buf.getvalue()
    assert marker not in output
    assert "private_key\t" in output


def test_scan_reports_an_email_without_printing_it(tmp_path: Path) -> None:
    marker = "person" + "@" + "example" + "." + "invalid"
    (tmp_path / "note.txt").write_text(marker + "\n", encoding="utf-8")
    buf = io.StringIO()
    assert scan_repo(tmp_path, buf) == 1
    output = buf.getvalue()
    assert marker not in output
    assert "@" not in output
    assert "email\t" in output


def test_scan_reports_an_address_without_printing_it(tmp_path: Path) -> None:
    marker = ".".join(("198", "51", "100", "20"))
    (tmp_path / "note.txt").write_text(marker + "\n", encoding="utf-8")
    buf = io.StringIO()
    assert scan_repo(tmp_path, buf) == 1
    output = buf.getvalue()
    assert marker not in output
    assert "ipv4\t" in output


def test_scan_reports_a_url_password_without_printing_it(tmp_path: Path) -> None:
    marker = "postgresql://" + "dbuser" + ":" + "s3cret" + "@" + "localhost/app"
    (tmp_path / "note.txt").write_text(marker + "\n", encoding="utf-8")
    buf = io.StringIO()
    assert scan_repo(tmp_path, buf) == 1
    output = buf.getvalue()
    assert marker not in output
    assert "s3cret" not in output
    assert "url_password\t" in output
