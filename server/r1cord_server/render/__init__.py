"""Native HTML renderer for recording pages: MD DOCS' themes and export shell, without MD DOCS.

Deliberately free of imports from the rest of r1cord_server (config imports this package).
"""

from .markdown import render_fragment
from .site import MANIFEST_NAME, PAGE_KINDS, RENDERER_VERSION, PageSource, SiteManifest, build_site, deploy_site
from .themes import DEFAULT_THEME_ID, Theme, get_theme, list_themes

__all__ = [
    "DEFAULT_THEME_ID",
    "MANIFEST_NAME",
    "PAGE_KINDS",
    "RENDERER_VERSION",
    "PageSource",
    "SiteManifest",
    "Theme",
    "build_site",
    "deploy_site",
    "get_theme",
    "list_themes",
    "render_fragment",
]
