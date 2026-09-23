from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline.writers import WriterError, validate_summary


def test_broken_image_link_rewritten_to_italic_alt_and_logged(tmp_path: Path) -> None:
    photos = tmp_path / "photos"
    photos.mkdir()
    (photos / "ok.jpg").write_bytes(b"jpeg")
    (tmp_path / "summary.md").write_text(
        "[brand-header]\n"
        "# Visit\n\n"
        "![good shot](photos/ok.jpg)\n"
        "![also good](./photos/ok.jpg)\n"
        "![missing photo](photos/nope.jpg)\n",
        encoding="utf-8",
    )
    lines: list[str] = []
    out = validate_summary(tmp_path, lines.append)
    text = out.read_text(encoding="utf-8")
    assert "![good shot](photos/ok.jpg)" in text
    assert "![also good](./photos/ok.jpg)" in text
    assert "![missing photo](photos/nope.jpg)" not in text
    assert "*missing photo*" in text
    assert any("photos/nope.jpg" in line and "missing photo" in line for line in lines)
    assert (tmp_path / "photos" / "ok.jpg").is_file()


def test_missing_brand_header_inserted_as_first_line(tmp_path: Path) -> None:
    (tmp_path / "photos").mkdir()
    (tmp_path / "summary.md").write_text("# Title\n\nBody.\n", encoding="utf-8")
    lines: list[str] = []
    out = validate_summary(tmp_path, lines.append)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("[brand-header]\n")
    assert "# Title" in text
    assert any("brand-header" in line for line in lines)


def test_missing_or_empty_summary_raises_writer_error(tmp_path: Path) -> None:
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)
    (tmp_path / "summary.md").write_text("", encoding="utf-8")
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)
    (tmp_path / "summary.md").write_text(" \n\t\n", encoding="utf-8")
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)
