from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _render_html import active_markup, parse

from r1cord_server.render import MANIFEST_NAME, PageSource, SiteManifest, build_site, deploy_site, get_theme

TITLE = "Sep 23, 00:54"
SUMMARY = """[brand-header]
# Sep 23, 00:54

The speaker describes R1 Chord. See the [outline](outline.html) and [transcript](transcript.md).

![The device](photos/photo-001.jpg)

## Action items

- [ ] None stated in the recording.
"""
OUTLINE = "[brand-header]\n# Sep 23, 00:54\n\n- Story\n    - Pronounced \"ReCord\"\n"
TRANSCRIPT = "[brand-header]\n\n# Sep 23, 00:54\n\n*2026-09-22 23:54 · 1:33*\n\nOkay, let's tell the story.\n"


def _pages() -> list[PageSource]:
    return [
        PageSource("summary", "Summary", SUMMARY),
        PageSource("outline", "Outline", OUTLINE),
        PageSource("transcript", "Transcript", TRANSCRIPT),
    ]


def _photos(tmp_path: Path) -> Path:
    photos = tmp_path / "inbox"
    photos.mkdir()
    (photos / "photo-001.jpg").write_bytes(b"\xff\xd8 shown")
    (photos / "photo-002.jpg").write_bytes(b"\xff\xd8 never referenced")
    return photos


def _tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _build(tmp_path: Path, name: str = "site", theme: str = "toolmaker-noir") -> tuple[Path, SiteManifest]:
    dest = tmp_path / name
    photos = tmp_path / "inbox" if (tmp_path / "inbox").is_dir() else _photos(tmp_path)
    return dest, build_site(_pages(), title=TITLE, photos_dir=photos, theme=theme, dest=dest)


def test_build_writes_pages_sources_assets_photos_and_a_complete_manifest(tmp_path: Path) -> None:
    dest, manifest = _build(tmp_path)
    tree = _tree(dest)
    assert manifest.pages == ["transcript", "summary", "outline"]  # canonical order, whatever the input order
    assert set(tree) - {MANIFEST_NAME} == set(manifest.files)
    assert {rel: hashlib.sha256(data).hexdigest() for rel, data in tree.items() if rel != MANIFEST_NAME} == manifest.files
    assert SiteManifest.from_json(tree[MANIFEST_NAME].decode("utf-8")) == manifest
    assert {rel for rel in tree if "/" not in rel} == {
        MANIFEST_NAME,
        *(f"{kind}.{ext}" for kind in ("transcript", "summary", "outline") for ext in ("html", "md")),
    }
    assert sorted(rel.split(".")[0] for rel in tree if rel.startswith("assets/")) == ["assets/page", "assets/site", "assets/theme"]


def test_md_sources_are_published_without_the_brand_header_line(tmp_path: Path) -> None:
    dest, _ = _build(tmp_path)
    assert (dest / "summary.md").read_text(encoding="utf-8") == SUMMARY.removeprefix("[brand-header]\n")
    assert (dest / "transcript.md").read_text(encoding="utf-8").startswith("# Sep 23, 00:54\n")
    for kind in ("summary", "outline", "transcript"):
        assert "brand-header" not in (dest / f"{kind}.html").read_text(encoding="utf-8")


def test_every_page_navigates_to_every_page_and_offers_its_markdown(tmp_path: Path) -> None:
    dest, _ = _build(tmp_path)
    for kind in ("transcript", "summary", "outline"):
        doc = parse((dest / f"{kind}.html").read_text(encoding="utf-8"))
        nav = doc.find_all(lambda n: n.tag == "nav" and n.attrs.get("aria-label") == "Pages")[0]
        hrefs = [(a.attrs["href"], a.attrs.get("aria-current")) for a in nav.find_all(lambda n: n.tag == "a")]
        assert hrefs == [(f"{k}.html", "page" if k == kind else None) for k in ("transcript", "summary", "outline")]
        (download,) = doc.find_all(lambda n: n.tag == "a" and "download" in n.attrs)
        assert download.attrs["href"] == f"{kind}.md"


def test_only_referenced_existing_photos_are_copied(tmp_path: Path) -> None:
    dest, manifest = _build(tmp_path)
    assert sorted(rel for rel in manifest.files if rel.startswith("photos/")) == ["photos/photo-001.jpg"]
    assert (dest / "photos" / "photo-001.jpg").read_bytes() == b"\xff\xd8 shown"


def test_build_is_byte_deterministic(tmp_path: Path) -> None:
    first, _ = _build(tmp_path, "one")
    second = tmp_path / "two"
    build_site(list(reversed(_pages())), title=TITLE, photos_dir=tmp_path / "inbox", theme="Toolmaker-Noir", dest=second)
    assert _tree(first) == _tree(second)


def test_hostile_markdown_and_title_produce_no_active_markup_and_no_files_outside_dest(tmp_path: Path) -> None:
    photos = _photos(tmp_path)
    secret = tmp_path / "secret.jpg"
    secret.write_bytes(b"secret bytes")
    (photos / "notaphoto.png").write_bytes(b"png")
    hostile = "\n\n".join(
        [
            "# Title <script>alert(1)</script>",
            '<img src=x onerror="alert(1)"> <iframe src="https://evil.example"></iframe>',
            "[js](javascript:alert(document.cookie)) [data](data:text/html,<script>alert(1)</script>)",
            f"![up](../secret.jpg) ![abs]({secret.as_posix()}) ![trav](photos/../../secret.jpg)",
            "![png](photos/notaphoto.png) ![missing](photos/photo-404.jpg) ![ok](photos/photo-001.jpg)",
            "[sibling-missing](organized.html) [up](../../index.html)",
        ]
    )
    title = '</title><script>alert("t")</script><meta http-equiv="refresh" content="0;url=https://evil.example">'
    before = set(_tree(tmp_path))
    dest = tmp_path / "site"
    build_site([PageSource("summary", "Summary <b>", hostile)], title=title, photos_dir=photos, theme="github-light", dest=dest)

    assert {rel for rel in _tree(tmp_path) if rel not in before} == {f"site/{rel}" for rel in _tree(dest)}
    assert sorted(rel for rel in _tree(dest) if rel.startswith("photos/")) == ["photos/photo-001.jpg"]
    assert b"secret bytes" not in b"".join(_tree(dest).values())
    html = (dest / "summary.html").read_text(encoding="utf-8")
    assert active_markup(html, pages=frozenset({"summary.html", "summary.md"}), photos=frozenset({"photo-001.jpg"})) == []
    doc = parse(html)
    assert doc.find_all(lambda n: n.tag == "title")[0].text() == f"{title} — Summary <b>"


def test_csp_allows_same_origin_script_and_only_the_theme_font_hosts(tmp_path: Path) -> None:
    policies = {}
    for theme in ("toolmaker-noir", "altuit-toc-sketchnote", "notion"):
        dest = tmp_path / theme
        build_site([PageSource("summary", "Summary", "# T\n")], title="T", photos_dir=None, theme=theme, dest=dest)
        doc = parse((dest / "summary.html").read_text(encoding="utf-8"))
        (meta,) = doc.find_all(lambda n: n.tag == "meta" and n.attrs.get("http-equiv") == "Content-Security-Policy")
        directives = dict(part.strip().split(" ", 1) for part in meta.attrs["content"].split(";"))
        assert directives["default-src"] == "'none'"
        assert directives["script-src"] == "'self'"
        assert "unsafe" not in meta.attrs["content"]
        policies[theme] = (directives["style-src"], directives["font-src"])
    assert policies["toolmaker-noir"] == ("'self' https://fonts.googleapis.com", "'self' https://fonts.gstatic.com")
    # Sketchnote's @font-face files live on their own host; read it from the vendored theme.
    sketch_host = re.search(r"@font-face[^}]*url\('(https://[^/']+)", get_theme("altuit-toc-sketchnote").css).group(1)
    assert policies["altuit-toc-sketchnote"] == (
        "'self' https://fonts.googleapis.com",
        f"'self' https://fonts.gstatic.com {sketch_host}",
    )
    assert policies["notion"] == ("'self'", "'self'")


def test_build_empties_a_previous_site_but_refuses_a_folder_that_is_not_one(tmp_path: Path) -> None:
    dest, _ = _build(tmp_path)
    (dest / "stale.html").write_text("old", encoding="utf-8")
    _build(tmp_path)
    assert not (dest / "stale.html").exists()

    other = tmp_path / "publish"
    other.mkdir()
    (other / "keep.txt").write_text("user file", encoding="utf-8")
    with pytest.raises(ValueError):
        build_site(_pages(), title=TITLE, photos_dir=None, theme="notion", dest=other)
    assert (other / "keep.txt").read_text(encoding="utf-8") == "user file"


def test_bad_page_lists_are_rejected(tmp_path: Path) -> None:
    for pages in ([], [PageSource("notes", "Notes", "x")], [PageSource("summary", "A", "x"), PageSource("summary", "B", "y")]):
        with pytest.raises(ValueError):
            build_site(pages, title="T", photos_dir=None, theme="notion", dest=tmp_path / "site")
    with pytest.raises(ValueError):
        build_site(_pages(), title="T", photos_dir=None, theme="nope", dest=tmp_path / "site")


# ---------------------------------------------------------------- deploy


def _site(tmp_path: Path, name: str, pages: list[PageSource], theme: str = "toolmaker-noir") -> Path:
    photos = tmp_path / "inbox" if (tmp_path / "inbox").is_dir() else _photos(tmp_path)
    build_site(pages, title=TITLE, photos_dir=photos, theme=theme, dest=tmp_path / name)
    return tmp_path / name


def test_deploy_order_puts_summary_after_other_pages_and_the_manifest_last(tmp_path: Path) -> None:
    src = _site(tmp_path, "site", _pages())
    written = deploy_site(src, tmp_path / "publish")
    assert written[-1] == MANIFEST_NAME
    assert written[-2] == "summary.html"
    first_page = min(i for i, rel in enumerate(written) if "/" not in rel)
    assert all("/" in rel for rel in written[:first_page])  # assets and photos first
    assert written[first_page : first_page + 3] == ["transcript.md", "summary.md", "outline.md"]
    assert written[first_page + 3 : -2] == ["transcript.html", "outline.html"]
    assert _tree(tmp_path / "publish") == _tree(src)


def test_redeploying_an_unchanged_site_rewrites_only_the_manifest(tmp_path: Path) -> None:
    src = _site(tmp_path, "site", _pages())
    deploy_site(src, tmp_path / "publish")
    assert deploy_site(src, tmp_path / "publish") == [MANIFEST_NAME]


def test_deploy_deletes_only_files_the_previous_manifest_listed(tmp_path: Path) -> None:
    publish = tmp_path / "publish"
    publish.mkdir()
    legacy = {"summary.css": b"legacy MD DOCS css", "notes.txt": b"user file", "summary_images/x.png": b"img"}
    for rel, data in legacy.items():
        (publish / rel).parent.mkdir(parents=True, exist_ok=True)
        (publish / rel).write_bytes(data)
    old = _site(tmp_path, "old", _pages(), theme="toolmaker-noir")
    deploy_site(old, publish)
    old_files = set(SiteManifest.from_json((old / MANIFEST_NAME).read_text(encoding="utf-8")).files)

    new = _site(tmp_path, "new", [PageSource("transcript", "Transcript", TRANSCRIPT)], theme="notion")
    deploy_site(new, publish)
    new_files = set(SiteManifest.from_json((new / MANIFEST_NAME).read_text(encoding="utf-8")).files)

    remaining = set(_tree(publish))
    assert remaining == new_files | set(legacy) | {MANIFEST_NAME}
    assert not (old_files - new_files) & remaining
    assert not (publish / "photos").exists()  # emptied by the cleanup
    for rel, data in legacy.items():
        assert (publish / rel).read_bytes() == data


def test_a_hostile_previous_manifest_cannot_delete_outside_its_names(tmp_path: Path) -> None:
    publish = tmp_path / "publish"
    publish.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep", encoding="utf-8")
    (publish / "keep.html").write_text("keep", encoding="utf-8")
    digest = "0" * 64
    hostile = {"renderer": "x", "theme": "notion", "pages": [], "files": {"../outside.txt": digest, "keep.html": digest}}
    (publish / MANIFEST_NAME).write_text(json.dumps(hostile), encoding="utf-8")
    deploy_site(_site(tmp_path, "site", _pages()), publish)
    assert outside.read_text(encoding="utf-8") == "keep"
    assert (publish / "keep.html").read_text(encoding="utf-8") == "keep"
    with pytest.raises(ValueError):
        SiteManifest.from_json(json.dumps(hostile))


def test_deploy_refuses_a_site_that_does_not_match_its_manifest_before_writing(tmp_path: Path) -> None:
    src = _site(tmp_path, "site", _pages())
    (src / "outline.html").write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError):
        deploy_site(src, tmp_path / "publish")
    assert not (tmp_path / "publish").exists() or _tree(tmp_path / "publish") == {}
