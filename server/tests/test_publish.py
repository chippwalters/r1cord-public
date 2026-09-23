from __future__ import annotations

from pathlib import Path

import pytest

from r1cord_server import render
from r1cord_server.pipeline import publish
from r1cord_server.pipeline.publish import PublishError


def _outbox(tmp_path: Path) -> Path:
    outbox = tmp_path / "outbox" / "rec-1"
    photos = outbox / "photos"
    photos.mkdir(parents=True)
    (outbox / "transcript.md").write_text("[brand-header]\n# Site visit\n\nhello\n", encoding="utf-8")
    (outbox / "summary.md").write_text("# Site visit\n\nbody\n\n![Gate](photos/photo-a.jpg)\n", encoding="utf-8")
    (outbox / "summary.job-old.md").write_text("# an archived rewrite\n", encoding="utf-8")
    (photos / "photo-a.jpg").write_bytes(b"jpeg-a")
    return outbox


def _leftovers(outbox: Path) -> list[str]:
    return [p.name for p in outbox.iterdir() if p.name.startswith(".site")]


def test_site_holds_every_source_page_in_page_order_with_its_photos(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    (outbox / "outline.md").write_text("# Site visit\n\n- point\n", encoding="utf-8")

    manifest = publish.build(outbox, title="Site visit", theme="toolmaker-noir")

    site = outbox / publish.SITE_DIR
    assert manifest.pages == ["transcript", "summary", "outline"]
    for kind in manifest.pages:
        assert (site / f"{kind}.html").is_file() and (site / f"{kind}.md").is_file()
    assert (site / "photos" / "photo-a.jpg").read_bytes() == b"jpeg-a"
    assert not (site / "organized.html").exists()  # no source, no page
    assert "archived rewrite" not in "".join(p.read_text(encoding="utf-8") for p in site.glob("*.md"))
    assert _leftovers(outbox) == []


def test_transcript_page_comes_from_transcript_txt_when_there_is_no_transcript_md(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox" / "rec-2"
    outbox.mkdir(parents=True)
    (outbox / "transcript.txt").write_text("said <b>this</b>", encoding="utf-8")

    manifest = publish.build(outbox, title="Old take", theme="toolmaker-noir")

    assert manifest.pages == ["transcript"]
    html = (outbox / publish.SITE_DIR / "transcript.html").read_text(encoding="utf-8")
    assert "Old take" in html and "<b>this</b>" not in html


def test_rebuild_replaces_the_site_and_a_failed_build_keeps_the_previous_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outbox = _outbox(tmp_path)
    publish.build(outbox, title="Site visit", theme="toolmaker-noir")
    site = outbox / publish.SITE_DIR
    (outbox / "organized.md").write_text("# Site visit\n\n## Gate\n", encoding="utf-8")

    rebuilt = publish.build(outbox, title="Site visit", theme="github-light")
    assert rebuilt.theme == "github-light" and "organized" in rebuilt.pages
    assert (site / "organized.html").is_file()
    before = {p.relative_to(site): p.read_bytes() for p in site.rglob("*") if p.is_file()}

    def half_then_fail(pages, *, title, photos_dir, theme, dest):
        Path(dest).mkdir(parents=True)
        (Path(dest) / "summary.html").write_text("half", encoding="utf-8")
        raise OSError("disk full")

    monkeypatch.setattr(render, "build_site", half_then_fail)
    with pytest.raises(PublishError, match="disk full"):
        publish.build(outbox, title="Site visit", theme="toolmaker-noir")
    assert {p.relative_to(site): p.read_bytes() for p in site.rglob("*") if p.is_file()} == before
    assert _leftovers(outbox) == []


def test_build_without_any_source_raises(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox" / "rec-3"
    outbox.mkdir(parents=True)
    with pytest.raises(PublishError, match="nothing to publish"):
        publish.build(outbox, title="T", theme="toolmaker-noir")
    assert not (outbox / publish.SITE_DIR).exists()


def test_build_drops_the_old_md_docs_staging_folder(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    (outbox / "publish" / "photos").mkdir(parents=True)
    (outbox / "publish" / "summary.md").write_text("staged", encoding="utf-8")
    publish.build(outbox, title="Site visit", theme="toolmaker-noir")
    assert not (outbox / "publish").exists()
    assert (outbox / "summary.md").is_file()  # the sources stay


def test_deploy_copies_the_site_and_logs_each_file(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    publish.build(outbox, title="Site visit", theme="toolmaker-noir")
    folder = tmp_path / "webdav" / "2026" / "09" / "site-visit"
    lines: list[str] = []

    written = publish.deploy(outbox / publish.SITE_DIR, folder, lines.append)

    assert {"transcript.html", "summary.html", "transcript.md", "summary.md"} <= set(written)
    assert (folder / "summary.html").read_bytes() == (outbox / publish.SITE_DIR / "summary.html").read_bytes()
    assert (folder / "photos" / "photo-a.jpg").is_file()
    assert [f"publish: wrote {rel}" for rel in written] == lines


def test_deploy_failure_raises_publish_error(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    with pytest.raises(PublishError, match="deploy to"):
        publish.deploy(outbox / publish.SITE_DIR, tmp_path / "pub", lambda _l: None)  # never built


def test_legacy_artifacts_are_only_the_css_and_images_of_the_given_pages(tmp_path: Path) -> None:
    folder = tmp_path / "pub"
    (folder / "summary_images").mkdir(parents=True)
    (folder / "outline_images").mkdir()
    for name in ("summary.css", "Outline.css", "summary.html", "summary.md", "notes.css", "transcript.css"):
        (folder / name).write_text("x", encoding="utf-8")
    (folder / "transcript_images").write_text("a file, not a folder", encoding="utf-8")

    found = publish.legacy_artifacts(folder, ["summary", "outline", "transcript"])

    assert found == ["summary.css", "summary_images/", "Outline.css", "outline_images/", "transcript.css"]
    assert publish.legacy_artifacts(folder, ["organized"]) == []
    assert publish.legacy_artifacts(tmp_path / "missing", ["summary"]) == []
