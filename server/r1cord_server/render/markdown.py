"""Markdown -> body HTML with MD DOCS' parser settings, minus raw HTML, plus the link/image policy.

markdown-it-py `js-default` (raw HTML escaped, tables, strikethrough) with linkify and typographer,
heading ids from MD DOCS' slug algorithm (src/utils/anchorSlug.js + markdown-it-anchor's unique
suffixes), and task lists as disabled checkboxes.

Policy, applied to the token stream so nothing active reaches the page:
- links: http, https, mailto, #anchor, and the sibling page files the caller allows; external
  links open in a new tab with rel="noopener noreferrer". Anything else keeps its text, no link.
- images: only `photos/photo-*.jpg` that the caller says exist; anything else becomes its alt
  text in italics.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from markdown_it import MarkdownIt
from markdown_it.rules_core import StateCore
from markdown_it.token import Token
from mdit_py_plugins.anchors import anchors_plugin
from mdit_py_plugins.tasklists import tasklists_plugin

PHOTO_NAME = re.compile(r"photo-[A-Za-z0-9._-]+\.jpg")
_PHOTO_SRC = re.compile(r"photos/(photo-[A-Za-z0-9._-]+\.jpg)")
_EXTERNAL = re.compile(r"(?:https?://|mailto:)", re.IGNORECASE)
_WEB = re.compile(r"https?://", re.IGNORECASE)
_SIBLING = re.compile(r"([a-z]+\.(?:html|md))(#[A-Za-z0-9_-]*)?")
_BRAND_HEADER = re.compile(r"\A\ufeff?(?:[ \t]*\r?\n)*[ \t]*\[brand-header\][ \t]*(?:\r?\n|\Z)(?:[ \t]*\r?\n)*", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")

# JS `\w` is ASCII; JS `\s` is Unicode whitespace (ECMAScript WhiteSpace + LineTerminator).
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_NOT_SLUG = re.compile(rf"[^A-Za-z0-9_{_JS_SPACE}-]")
_SPACES = re.compile(rf"[{_JS_SPACE}]+")
_EDGE_DASHES = re.compile(r"^-+|-+$")


def slugify(text: str) -> str:
    """MD DOCS' GitHub-style slug (anchorSlug.js `slugify`)."""
    slug = _NOT_SLUG.sub("", text.strip(_JS_SPACE).lower())
    return _EDGE_DASHES.sub("", _SPACES.sub("-", slug))


def _heading_slug(text: str) -> str:
    # MD DOCS would emit id="" for a heading with no slug characters; give it a usable anchor.
    return slugify(text) or "section"


def strip_brand_header(markdown: str) -> str:
    """Drop a legacy leading `[brand-header]` line (and the blank lines after it)."""
    return _BRAND_HEADER.sub("", markdown, count=1)


@dataclass(frozen=True)
class Policy:
    pages: frozenset[str] = frozenset()  # sibling page files that may be linked, e.g. "summary.html"
    photos: frozenset[str] = frozenset()  # photo file names that exist and may be shown


@dataclass(frozen=True)
class Heading:
    level: int
    id: str
    html: str  # heading content as escaped plain text (tags stripped, as MD DOCS' TOC does)


@dataclass(frozen=True)
class Rendered:
    html: str
    headings: tuple[Heading, ...]
    photos: tuple[str, ...]  # photos the body shows, sorted


def _allowed_href(href: str, policy: Policy) -> bool:
    if href.startswith("#"):
        return True
    if _EXTERNAL.match(href):
        return True
    sibling = _SIBLING.fullmatch(href)
    return bool(sibling and sibling.group(1) in policy.pages)


def _apply_policy(state: StateCore) -> None:
    policy: Policy = state.env["policy"]
    shown: set[str] = state.env["photos"]
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        children: list[Token] = []
        open_links: list[bool] = []  # per open link: kept? (a dropped link_open drops its link_close)
        for token in block.children:
            if token.type == "link_open":
                href = str(token.attrGet("href") or "")
                keep = _allowed_href(href, policy)
                open_links.append(keep)
                if not keep:
                    continue
                if _WEB.match(href):
                    token.attrSet("target", "_blank")
                    token.attrSet("rel", "noopener noreferrer")
            elif token.type == "link_close":
                if open_links and not open_links.pop():
                    continue
            elif token.type == "image":
                match = _PHOTO_SRC.fullmatch(str(token.attrGet("src") or ""))
                if match and match.group(1) in policy.photos:
                    shown.add(match.group(1))
                else:
                    alt = state.md.renderer.renderInlineAsText(token.children or [], state.md.options, state.env)
                    if alt.strip():
                        children.extend(
                            [Token("em_open", "em", 1), Token("text", "", 0, content=alt), Token("em_close", "em", -1)]
                        )
                    continue
            children.append(token)
        block.children = children


def _build() -> MarkdownIt:
    md = MarkdownIt("js-default", {"linkify": True, "typographer": True})
    anchors_plugin(md, min_level=1, max_level=6, slug_func=_heading_slug)
    tasklists_plugin(md, enabled=False)
    md.core.ruler.push("r1cord_policy", _apply_policy)
    return md


_MD = _build()


def render(markdown: str, policy: Policy = Policy()) -> Rendered:
    """Body HTML, the h1-h3 outline for the contents panel, and the photos shown."""
    env: dict = {"policy": policy, "photos": set()}
    tokens = _MD.parse(markdown, env)
    headings = []
    for index, token in enumerate(tokens):
        if token.type == "heading_open" and token.tag in ("h1", "h2", "h3"):
            inline = _MD.renderer.renderInline(tokens[index + 1].children or [], _MD.options, env)
            text = _TAG.sub("", inline).strip()
            if text:
                headings.append(Heading(level=int(token.tag[1]), id=str(token.attrGet("id")), html=text))
    html = _MD.renderer.render(tokens, _MD.options, env)
    return Rendered(html=html, headings=tuple(headings), photos=tuple(sorted(env["photos"])))


def render_fragment(markdown: str) -> str:
    """Same rules, body HTML only (email): web/mail/#anchor links only, images become alt text."""
    return render(strip_brand_header(markdown)).html
