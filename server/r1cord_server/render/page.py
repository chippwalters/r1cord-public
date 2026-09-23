"""Page shells reproducing MD DOCS' browser export (RightPanel.jsx), the chrome stylesheet, the CSP.

Two layouts, chosen by the theme: "toc" (site header, contents sidebar, card) and "standard"
(`<body class="theme-<id>">` with the theme CSS, plus a minimal header bar). Both always carry the
document title (no logo), page navigation and a Download .md link. No inline script or style: the page's
Content-Security-Policy allows only same-origin script and styles plus the theme's font hosts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from markupsafe import Markup

from .markdown import Heading, Rendered
from .themes import Theme

ASSETS_DIR = Path(__file__).parent / "assets"
_TEMPLATES = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    autoescape=True,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
    undefined=StrictUndefined,
)

_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?['"]?(https://[^'")\s;]+)""", re.IGNORECASE)
_FONT_FACE = re.compile(r"@font-face\s*\{[^}]*\}", re.IGNORECASE)
_URL = re.compile(r"""url\(\s*['"]?(https://[^'")\s]+)""", re.IGNORECASE)
_HOST = re.compile(r"[a-z0-9.-]+(?::[0-9]+)?")
# A stylesheet host whose CSS pulls its font files from another host.
_FONT_FILES_HOST = {"https://fonts.googleapis.com": "https://fonts.gstatic.com"}


@dataclass(frozen=True)
class NavItem:
    label: str
    href: str
    current: bool


@dataclass
class TocEntry:
    id: str
    html: Markup
    section: str  # "toc-h1" / "toc-h2" for collapsible sections, "" for a plain item
    children: list[TocEntry] = field(default_factory=list)


@dataclass(frozen=True)
class AssetLinks:
    site_css: str
    theme_css: str
    page_js: str | None  # toc layout only


def default_mode(theme: Theme) -> str:
    """data-theme the page opens with, as MD DOCS decides it (no [theme:] tag support)."""
    return "light" if theme.id == "altuit-toc-light" or theme.light else "dark"


def _origin(url: str) -> str | None:
    host = urlsplit(url).netloc.lower()
    return f"https://{host}" if _HOST.fullmatch(host) else None


def csp(theme: Theme) -> str:
    """Content-Security-Policy for a page in `theme`: same-origin everything, plus its font hosts."""
    style_hosts: set[str] = set()
    font_hosts: set[str] = set()
    for url in _IMPORT.findall(theme.css):
        origin = _origin(url)
        if origin:
            style_hosts.add(origin)
            font_hosts.add(_FONT_FILES_HOST.get(origin, origin))
    for block in _FONT_FACE.findall(theme.css):
        for url in _URL.findall(block):
            origin = _origin(url)
            if origin:
                font_hosts.add(origin)
    styles = "".join(f" {host}" for host in sorted(style_hosts))
    fonts = "".join(f" {host}" for host in sorted(font_hosts))
    return (
        "default-src 'none'; img-src 'self' data:; "
        f"style-src 'self'{styles}; font-src 'self'{fonts}; script-src 'self'; "
        "base-uri 'none'; form-action 'none'"
    )


@cache
def _asset_text(name: str) -> str:
    return (ASSETS_DIR / name).read_bytes().decode("utf-8")


def site_css(theme: Theme) -> str:
    """The page-chrome stylesheet for `theme`, loaded before the (verbatim) theme CSS."""
    if theme.layout == "toc":
        return _asset_text("site.css")
    colors = f":root {{\n  --r1-bg: {theme.background};\n  --r1-fg: {theme.text};\n}}\n\n"
    return _asset_text("site.css") + "\n" + colors + _asset_text("standard.css")


def page_js() -> str:
    return _asset_text("page.js")



def build_toc(headings: tuple[Heading, ...]) -> list[TocEntry]:
    """MD DOCS' contents tree: h1 and h2 are collapsible sections, h3 plain items.

    Unlike MD DOCS, h2 sections before the first h1 are kept (MD DOCS drops them).
    """
    top: list[TocEntry] = []
    h1: TocEntry | None = None
    h2: TocEntry | None = None

    def close_h2() -> None:
        nonlocal h2
        if h2:
            (h1.children if h1 else top).append(h2)
            h2 = None

    def close_h1() -> None:
        nonlocal h1
        close_h2()
        if h1:
            top.append(h1)
            h1 = None

    for heading in headings:
        entry = TocEntry(id=heading.id, html=Markup(heading.html), section="")
        if heading.level == 1:
            close_h1()
            entry.section = "toc-h1"
            h1 = entry
        elif heading.level == 2:
            close_h2()
            entry.section = "toc-h2"
            h2 = entry
        else:
            (h2.children if h2 else h1.children if h1 else top).append(entry)
    close_h1()
    return top


def render_page(
    *,
    theme: Theme,
    title: str,
    label: str,
    kind: str,
    nav: list[NavItem],
    rendered: Rendered,
    assets: AssetLinks,
) -> str:
    """One complete HTML page. `title` and labels are escaped; `rendered.html` is trusted body HTML."""
    context = {
        "csp": csp(theme),
        "title": title,
        "label": label,
        "site_css": assets.site_css,
        "theme_css": assets.theme_css,
        "nav": nav,
        "md_href": f"{kind}.md",
        "body": Markup(rendered.html.rstrip("\n")),
    }
    if theme.layout == "toc":
        template = _TEMPLATES.get_template("toc.html")
        context.update(mode=default_mode(theme), toc=build_toc(rendered.headings), page_js=assets.page_js)
    else:
        template = _TEMPLATES.get_template("standard.html")
        context.update(theme_id=theme.id)
    return template.render(context)
