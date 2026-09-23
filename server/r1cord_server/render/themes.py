"""The 12 MD DOCS themes vendored in ./themes, with metadata parsed exactly as MD DOCS does.

MD DOCS (src/main.js, `themes:read-all`) reads `@name`, `@background`, `@text` and `@layout` from
the theme's header comment. A theme gets the contents-sidebar ("toc") shell when it declares
`@layout toc` or its id starts with `altuit-toc` (the family predates the flag).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path

THEMES_DIR = Path(__file__).parent / "themes"
DEFAULT_THEME_ID = "toolmaker-noir"

# Same patterns as MD DOCS; JS `\w` is ASCII-only, hence re.ASCII.
_NAME = re.compile(r"@name\s+(.+)")
_BACKGROUND = re.compile(r"@background\s+(#[0-9A-Fa-f]{6})")
_TEXT = re.compile(r"@text\s+(#[0-9A-Fa-f]{6})")
_LAYOUT = re.compile(r"@layout\s+(\w+)", re.ASCII)


@dataclass(frozen=True)
class Theme:
    id: str
    name: str
    background: str
    text: str
    layout: str
    css: str

    @property
    def light(self) -> bool:
        """MD DOCS' export default: a theme whose @background red channel is >= 128 opens light."""
        return int(self.background[1:3], 16) >= 128


def parse_theme(theme_id: str, css: str) -> Theme:
    name = _NAME.search(css)
    background = _BACKGROUND.search(css)
    text = _TEXT.search(css)
    layout = _LAYOUT.search(css)
    declared = layout.group(1).strip().lower() if layout else "standard"
    return Theme(
        id=theme_id,
        name=name.group(1).strip() if name else "Untitled Theme",
        background=background.group(1) if background else "#FFFFFF",
        text=text.group(1) if text else "#000000",
        layout="toc" if declared == "toc" or theme_id.startswith("altuit-toc") else "standard",
        css=css,
    )


@cache
def _themes() -> tuple[Theme, ...]:
    # Bytes, not read_text(): the CSS is published verbatim, so no newline translation.
    themes = [parse_theme(path.stem, path.read_bytes().decode("utf-8")) for path in THEMES_DIR.glob("*.css")]
    return tuple(sorted(themes, key=lambda theme: (theme.name.casefold(), theme.id)))


def list_themes() -> list[Theme]:
    return list(_themes())


def get_theme(theme: str) -> Theme:
    """Theme by id or name, case-insensitive. ValueError when unknown."""
    wanted = str(theme).strip().casefold()
    for candidate in _themes():
        if wanted in (candidate.id.casefold(), candidate.name.casefold()):
            return candidate
    raise ValueError(f"unknown theme: {theme!r}")
