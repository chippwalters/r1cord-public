from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _render_html import active_markup, parse

from r1cord_server.render import render_fragment
from r1cord_server.render.markdown import Policy, render, slugify, strip_brand_header

# Heading ids MD DOCS 1.2.85 produces for this document (markdown-it 14 + markdown-it-anchor 9 with
# src/utils/anchorSlug.js `slugify`, typographer on), recorded from MD DOCS' own modules.
SLUG_DOC = """# Sep 23, 00:54

## Key points
## Key points
## Key-points
### Key points 1
## What's "next"?  -- now
### `code` & **bold** _it_
#### Notes
## Notes
## Café résumé naïve
## ---Dashes---
##   Spaced   out
## Überblick 2026
## 日本語 heading
## A\u00a0B nbsp
## emoji \U0001F389 party
## [Link text](https://example.com) here
## ![img alt](photos/photo-1.jpg) pic
## under_score and 1.2.3
## key-points
## key-points-1
## İstanbul ǅ
"""
MD_DOCS_IDS = [
    (1, "sep-23-0054"),
    (2, "key-points"),
    (2, "key-points-1"),
    (2, "key-points-2"),
    (3, "key-points-1-1"),
    (2, "whats-next-now"),
    (3, "code-bold-it"),
    (4, "notes"),
    (2, "notes-1"),
    (2, "caf-rsum-nave"),
    (2, "dashes"),
    (2, "spaced-out"),
    (2, "berblick-2026"),
    (2, "heading"),
    (2, "a-b-nbsp"),
    (2, "emoji-party"),
    (2, "link-text-here"),
    (2, "pic"),
    (2, "under_score-and-123"),
    (2, "key-points-3"),
    (2, "key-points-1-2"),
    (2, "istanbul"),
]


def _headings(html: str) -> list[tuple[int, str]]:
    return [
        (int(node.tag[1]), node.attrs["id"])
        for node in parse(html).find_all(lambda n: n.tag in ("h1", "h2", "h3", "h4", "h5", "h6"))
    ]


def test_heading_ids_and_duplicate_suffixes_match_md_docs() -> None:
    assert _headings(render(SLUG_DOC).html) == MD_DOCS_IDS


def test_slugify_matches_md_docs_on_unicode_whitespace_and_punctuation() -> None:
    assert slugify("  Hello,\u2003World!  ") == "hello-world"
    assert slugify("--x--") == "x"
    assert slugify("Ünïcödé") == "ncd"


def test_contents_outline_is_h1_to_h3_in_document_order() -> None:
    rendered = render("# A\n\n#### Deep\n\n## B & <b>\n\n### C\n\n##### Deeper\n")
    assert [(h.level, h.id, h.html) for h in rendered.headings] == [
        (1, "a", "A"),
        (2, "b-b", "B &amp; &lt;b&gt;"),
        (3, "c", "C"),
    ]


def test_task_list_items_render_as_disabled_checkboxes() -> None:
    doc = parse(render("- [ ] open\n- [x] done\n- plain\n").html)
    boxes = doc.find_all(lambda n: n.tag == "input")
    assert [(b.attrs.get("type"), "disabled" in b.attrs, "checked" in b.attrs) for b in boxes] == [
        ("checkbox", True, False),
        ("checkbox", True, True),
    ]
    assert "[ ]" not in doc.text() and "[x]" not in doc.text()


def test_raw_html_is_shown_as_text_never_rendered() -> None:
    source = (
        "<script>alert(1)</script>\n\n"
        "Inline <img src=x onerror=alert(1)> and <iframe src=https://evil.example></iframe>.\n\n"
        '<div onclick="steal()">block</div>\n\n'
        "<style>body{display:none}</style>\n"
    )
    html = render(source).html
    assert active_markup(html) == []
    text = parse(html).text()
    assert "<script>alert(1)</script>" in text
    assert "<img src=x onerror=alert(1)>" in text


def test_link_policy_keeps_web_mail_anchor_and_sibling_pages_only() -> None:
    source = "\n".join(
        [
            "[web](https://example.com/a?b=1) [plain](http://example.com) [mail](mailto:a@example.com)",
            "[anchor](#key-points) [page](summary.html) [page-anchor](outline.html#x) [source](summary.md)",
            "[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)",
            "[vb](vbscript:msgbox) [file](file:///C:/Windows/win.ini) [up](../secret.html) [abs](/etc/passwd)",
            "[proto](//evil.example/x) [other](organized.html) [photo](photos/photo-1.jpg) [unc](\\\\server\\share)",
            "<javascript:alert(1)> www.example.org",
        ]
    )
    policy = Policy(pages=frozenset({"summary.html", "summary.md", "outline.html", "outline.md"}))
    html = render(source, policy).html
    assert active_markup(html, pages=policy.pages) == []
    links = {a.text(): a.attrs for a in parse(html).find_all(lambda n: n.tag == "a")}
    assert set(links) == {"web", "plain", "mail", "anchor", "page", "page-anchor", "source", "www.example.org"}
    for name in ("web", "plain", "www.example.org"):
        assert links[name]["target"] == "_blank"
        assert links[name]["rel"] == "noopener noreferrer"
    for name in ("mail", "anchor", "page", "source"):
        assert "target" not in links[name]
    # A refused link keeps its words.
    text = parse(html).text()
    for word in ("js", "data", "up", "abs", "proto", "other", "photo"):
        assert word in text


def test_image_policy_shows_only_existing_photos_and_otherwise_the_alt_text() -> None:
    source = "\n\n".join(
        [
            "![Desk](photos/photo-001.jpg)",
            "![Missing](photos/photo-404.jpg)",
            "![Up](photos/../photo-001.jpg)",
            "![Abs](C:/Users/x/photo-001.jpg)",
            "![Web](https://evil.example/pixel.gif)",
            "![Png](photos/photo-001.png)",
            "![Data](data:image/png;base64,iVBORw0KGgo=)",
            '![<b onmouseover="x">alt</b>](../x.jpg)',
            "![](photos/nothing.jpg)",
        ]
    )
    rendered = render(source, Policy(photos=frozenset({"photo-001.jpg"})))
    doc = parse(rendered.html)
    assert [img.attrs["src"] for img in doc.find_all(lambda n: n.tag == "img")] == ["photos/photo-001.jpg"]
    assert rendered.photos == ("photo-001.jpg",)
    assert [em.text() for em in doc.find_all(lambda n: n.tag == "em")] == [
        "Missing",
        "Up",
        "Abs",
        "Web",
        "Png",
        "Data",
        '<b onmouseover="x">alt</b>',
    ]
    assert active_markup(rendered.html, photos=frozenset({"photo-001.jpg"})) == []


def test_brand_header_is_dropped_only_as_the_leading_line() -> None:
    assert strip_brand_header("[brand-header]\n\n# Title\n") == "# Title\n"
    assert strip_brand_header("\ufeff[Brand-Header]\r\n# Title\r\n") == "# Title\r\n"
    assert strip_brand_header("# Title\n[brand-header]\n") == "# Title\n[brand-header]\n"


def test_render_fragment_drops_brand_header_page_links_and_images() -> None:
    html = render_fragment(
        "[brand-header]\n# Title\n\n[summary](summary.html) [web](https://example.com) "
        "![Desk](photos/photo-001.jpg) <script>x()</script>\n"
    )
    doc = parse(html)
    assert "brand-header" not in doc.text()
    assert [a.attrs["href"] for a in doc.find_all(lambda n: n.tag == "a")] == ["https://example.com"]
    assert doc.find_all(lambda n: n.tag == "img") == []
    assert [em.text() for em in doc.find_all(lambda n: n.tag == "em")] == ["Desk"]
    assert active_markup(html) == []
