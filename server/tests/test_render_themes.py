from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from _render_html import active_markup, parse

from r1cord_server.render import DEFAULT_THEME_ID, PageSource, build_site, get_theme, list_themes
from r1cord_server.render.markdown import render
from r1cord_server.render.page import build_toc
from r1cord_server.render.themes import THEMES_DIR, parse_theme

# The md-docs checkout the themes were vendored from: R1CORD_MD_DOCS, else a sibling of this repo.
MD_DOCS = Path(os.environ.get("R1CORD_MD_DOCS") or ROOT.parent / "md-docs")
TOC_THEMES = {"toolmaker-noir", "high-contrast", "altuit-toc", "altuit-toc-lg", "altuit-toc-light", "altuit-toc-sketchnote"}


def test_the_twelve_vendored_themes_parse_with_unique_ids_and_names_sorted_by_name() -> None:
    themes = list_themes()
    assert len(themes) == 12
    assert {t.id for t in themes} == {p.stem for p in THEMES_DIR.glob("*.css")}
    assert len({t.name.casefold() for t in themes}) == 12
    assert [t.name.casefold() for t in themes] == sorted(t.name.casefold() for t in themes)
    for theme in themes:
        assert theme.name != "Untitled Theme"
        assert theme.background.startswith("#") and len(theme.background) == 7
    assert get_theme(DEFAULT_THEME_ID).name == "Toolmaker-Noir"


def test_layout_detection_follows_md_docs_rules() -> None:
    assert {t.id for t in list_themes() if t.layout == "toc"} == TOC_THEMES
    header = "/**\n * @name X\n * @background #101010\n * @text #EEEEEE\n{layout} */\n"
    assert parse_theme("plain", header.format(layout=" * @layout toc\n")).layout == "toc"
    assert parse_theme("plain", header.format(layout=" * @layout TOC\n")).layout == "toc"
    assert parse_theme("plain", header.format(layout=" * @layout standard\n")).layout == "standard"
    assert parse_theme("plain", header.format(layout="")).layout == "standard"
    # The altuit-toc family predates the flag: matched by id.
    assert parse_theme("altuit-toc-new", header.format(layout="")).layout == "toc"


def test_missing_metadata_falls_back_to_md_docs_defaults() -> None:
    theme = parse_theme("bare", "body { color: red; }")
    assert (theme.name, theme.background, theme.text, theme.layout) == ("Untitled Theme", "#FFFFFF", "#000000", "standard")


def test_get_theme_accepts_id_or_name_case_insensitively_and_rejects_unknown() -> None:
    assert get_theme("TOOLMAKER-NOIR").id == "toolmaker-noir"
    assert get_theme("toolmaker-noir").id == "toolmaker-noir"
    assert get_theme("Toolmaker-Noir").id == "toolmaker-noir"
    assert get_theme("github light").id == "github-light"
    with pytest.raises(ValueError):
        get_theme("no-such-theme")
    with pytest.raises(ValueError):
        get_theme("")


def test_provenance_hashes_match_the_vendored_files() -> None:
    provenance = json.loads((THEMES_DIR / "PROVENANCE.json").read_text(encoding="utf-8"))
    vendored = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in THEMES_DIR.glob("*.css")}
    assert provenance["themes"] == vendored


@pytest.mark.skipif(not (MD_DOCS / "public" / "themes").is_dir(), reason="MD DOCS checkout not present")
def test_vendored_themes_have_not_drifted_from_md_docs() -> None:
    """Fails when MD DOCS changed a theme: run scripts/sync_themes.py deliberately."""
    source = {p.name: p.read_bytes() for p in (MD_DOCS / "public" / "themes").glob("*.css")}
    vendored = {p.name: p.read_bytes() for p in THEMES_DIR.glob("*.css")}
    assert set(vendored) == set(source)
    drifted = sorted(name for name in source if source[name] != vendored[name])
    assert drifted == []


SUMMARY = "[brand-header]\n# Title\n\n## Key points\n\n- one\n\n### Detail\n\nText.\n\n#### Too deep\n"


@pytest.mark.parametrize("theme", [t.id for t in list_themes()])
def test_every_theme_renders_its_layout_with_page_nav(tmp_path: Path, theme: str) -> None:
    pages = [PageSource("transcript", "Transcript", "# Title\n\nWords.\n"), PageSource("summary", "Summary", SUMMARY)]
    manifest = build_site(pages, title="Rec", photos_dir=None, theme=theme, dest=tmp_path / "site")
    assert manifest.theme == theme
    html = (tmp_path / "site" / "summary.html").read_text(encoding="utf-8")
    doc = parse(html)
    assert active_markup(html, pages=frozenset({"transcript.html", "transcript.md", "summary.html", "summary.md"})) == []

    nav = doc.find_all(lambda n: n.tag == "nav" and n.attrs.get("aria-label") == "Pages")
    assert len(nav) == 1
    links = nav[0].find_all(lambda n: n.tag == "a")
    assert [(a.attrs["href"], a.text().strip(), a.attrs.get("aria-current")) for a in links] == [
        ("transcript.html", "Transcript", None),
        ("summary.html", "Summary", "page"),
    ]
    download = doc.find_all(lambda n: n.tag == "a" and n.attrs.get("href") == "summary.md")
    assert len(download) == 1 and "download" in download[0].attrs
    # Pages are unbranded: the header names the recording, and no logo or vendor link appears.
    header = doc.find_all(lambda n: n.tag == "header")[0]
    assert "Rec" in header.text()
    assert doc.find_all(lambda n: n.tag == "svg") == []
    assert "chippwalters" not in html.lower()

    body = doc.find_all(lambda n: n.tag == "body")[0]
    if get_theme(theme).layout == "toc":
        toc = doc.by_id("tocList")
        assert [a.attrs["href"] for a in toc.find_all(lambda n: n.tag == "a")] == ["#title", "#key-points", "#detail"]
        assert body.attrs["data-theme"] in ("dark", "light")
        assert doc.by_id("themeToggle").tag == "button"
        assert doc.find_all(lambda n: n.tag == "script")[0].attrs["src"].startswith("assets/page.")
    else:
        assert body.attrs["class"] == f"theme-{theme}"
        assert doc.find_all(lambda n: n.tag == "script") == []


def test_toc_pages_open_in_the_mode_md_docs_chooses(tmp_path: Path) -> None:
    modes = {}
    for theme in ("toolmaker-noir", "high-contrast", "altuit-toc", "altuit-toc-light"):
        build_site([PageSource("summary", "Summary", "# T\n")], title="T", photos_dir=None, theme=theme, dest=tmp_path / theme)
        body = parse((tmp_path / theme / "summary.html").read_text(encoding="utf-8")).find_all(lambda n: n.tag == "body")[0]
        modes[theme] = body.attrs["data-theme"]
    assert modes == {"toolmaker-noir": "dark", "high-contrast": "light", "altuit-toc": "dark", "altuit-toc-light": "light"}


def test_contents_tree_nests_like_md_docs_and_keeps_sections_before_the_first_h1() -> None:
    toc = build_toc(render("## Early\n\n### Sub\n\n# Title\n\n### Loose\n\n## Later\n\n### Deep\n").headings)
    shape = [(e.id, e.section, [(c.id, c.section, [g.id for g in c.children]) for c in e.children]) for e in toc]
    assert shape == [
        ("early", "toc-h2", [("sub", "", [])]),
        ("title", "toc-h1", [("loose", "", []), ("later", "toc-h2", ["deep"])]),
    ]
