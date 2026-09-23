"""Build a recording's static site, and deploy it to the publish folder.

A site is <kind>.html + <kind>.md per page, assets/ (content-hashed theme CSS, chrome CSS, page
script), photos/ (only the photos the pages show) and .r1cord-site.json, the manifest of every
file written with its sha256. The manifest is what makes deploys safe: only files a previous
manifest listed are ever deleted from the publish folder.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from .markdown import PHOTO_NAME, Policy, render, strip_brand_header
from .page import AssetLinks, NavItem, page_js, render_page, site_css
from .themes import get_theme

RENDERER_VERSION = "r1cord-render/1"
MANIFEST_NAME = ".r1cord-site.json"
# Canonical page order (the same kinds as config.PAGE_KINDS; render/ stays free of app imports).
PAGE_KINDS = ("transcript", "summary", "outline", "organized")

_SHA256 = re.compile(r"[0-9a-f]{64}")
# Every path a site may contain. Manifests are validated against this before anything is
# deleted, so a damaged or hostile manifest cannot reach outside these names.
_SITE_PATH = re.compile(
    r"(?:transcript|summary|outline|organized)\.(?:html|md)"
    r"|assets/[a-z0-9-]+\.[0-9a-f]{12}\.[a-z0-9]+"
    r"|photos/photo-[A-Za-z0-9._-]+\.jpg"
)


@dataclass(frozen=True)
class PageSource:
    kind: str
    label: str
    markdown: str


@dataclass(frozen=True)
class SiteManifest:
    renderer: str
    theme: str
    pages: list[str]
    files: dict[str, str]

    def to_json(self) -> str:
        data = {"renderer": self.renderer, "theme": self.theme, "pages": list(self.pages), "files": dict(self.files)}
        return json.dumps(data, indent=2, sort_keys=True) + "\n"

    @staticmethod
    def from_json(text: str) -> SiteManifest:
        """Parse and validate. ValueError for anything that is not a well-formed site manifest."""
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"site manifest is not JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("site manifest is not an object")
        renderer, theme, pages, files = (data.get(key) for key in ("renderer", "theme", "pages", "files"))
        if not isinstance(renderer, str) or not isinstance(theme, str):
            raise ValueError("site manifest: renderer and theme must be strings")
        if not isinstance(pages, list) or any(kind not in PAGE_KINDS for kind in pages) or len(set(pages)) != len(pages):
            raise ValueError(f"site manifest: bad pages {pages!r}")
        if not isinstance(files, dict):
            raise ValueError("site manifest: files must be an object")
        for path, digest in files.items():
            if not isinstance(path, str) or not _SITE_PATH.fullmatch(path):
                raise ValueError(f"site manifest: bad path {path!r}")
            if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
                raise ValueError(f"site manifest: bad sha256 for {path}")
        return SiteManifest(renderer=renderer, theme=theme, pages=list(pages), files=dict(files))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hashed(stem: str, ext: str, data: bytes) -> str:
    return f"assets/{stem}.{_sha256(data)[:12]}.{ext}"


def _ordered(pages: list[PageSource]) -> list[PageSource]:
    by_kind: dict[str, PageSource] = {}
    for page in pages:
        if page.kind not in PAGE_KINDS:
            raise ValueError(f"unknown page kind: {page.kind!r}")
        if page.kind in by_kind:
            raise ValueError(f"duplicate page: {page.kind}")
        by_kind[page.kind] = page
    if not by_kind:
        raise ValueError("no pages to build")
    return [by_kind[kind] for kind in PAGE_KINDS if kind in by_kind]


def _available_photos(photos_dir: Path | None) -> dict[str, Path]:
    """photo-*.jpg regular files (not links) directly in photos_dir."""
    if photos_dir is None or not Path(photos_dir).is_dir():
        return {}
    found = {}
    with os.scandir(photos_dir) as entries:
        for entry in entries:
            if PHOTO_NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                found[entry.name] = Path(entry.path)
    return found


def _empty_dir(dest: Path) -> None:
    if dest.exists():
        if not dest.is_dir():
            raise ValueError(f"site destination is not a folder: {dest}")
        if any(dest.iterdir()) and not (dest / MANIFEST_NAME).is_file():
            raise ValueError(f"refusing to empty {dest}: it is not empty and holds no {MANIFEST_NAME}")
        shutil.rmtree(dest)
    dest.mkdir(parents=True)


def build_site(pages: list[PageSource], *, title: str, photos_dir: Path | None, theme: str, dest: Path) -> SiteManifest:
    """Render `pages` into `dest` (created, or emptied if it holds a previous site). Deterministic."""
    chosen = get_theme(theme)
    ordered = _ordered(pages)
    photos = _available_photos(photos_dir)
    sources = {page.kind: strip_brand_header(page.markdown) for page in ordered}
    policy = Policy(
        pages=frozenset(f"{page.kind}.{ext}" for page in ordered for ext in ("html", "md")),
        photos=frozenset(photos),
    )

    theme_bytes = chosen.css.encode("utf-8")
    chrome_bytes = site_css(chosen).encode("utf-8")
    script = page_js().encode("utf-8") if chosen.layout == "toc" else None  # standard pages have no script
    links = AssetLinks(
        site_css=_hashed("site", "css", chrome_bytes),
        theme_css=_hashed("theme", "css", theme_bytes),
        page_js=_hashed("page", "js", script) if script else None,
    )
    files: dict[str, bytes] = {links.site_css: chrome_bytes, links.theme_css: theme_bytes}
    if script:
        files[links.page_js] = script

    shown: set[str] = set()
    for page in ordered:
        rendered = render(sources[page.kind], policy)
        shown.update(rendered.photos)
        nav = [NavItem(label=p.label, href=f"{p.kind}.html", current=p.kind == page.kind) for p in ordered]
        html = render_page(
            theme=chosen, title=title, label=page.label, kind=page.kind, nav=nav, rendered=rendered, assets=links
        )
        files[f"{page.kind}.html"] = html.encode("utf-8")
        files[f"{page.kind}.md"] = sources[page.kind].encode("utf-8")
    for name in sorted(shown):
        files[f"photos/{name}"] = photos[name].read_bytes()

    dest = Path(dest)
    _empty_dir(dest)
    for rel in sorted(files):
        target = dest.joinpath(*rel.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[rel])
    manifest = SiteManifest(
        renderer=RENDERER_VERSION,
        theme=chosen.id,
        pages=[page.kind for page in ordered],
        files={rel: _sha256(data) for rel, data in sorted(files.items())},
    )
    (dest / MANIFEST_NAME).write_bytes(manifest.to_json().encode("utf-8"))
    return manifest


def _deploy_order(manifest: SiteManifest) -> list[str]:
    """Assets and photos, then the .md sources, then the pages with summary.html last."""
    kind_rank = {kind: rank for rank, kind in enumerate(PAGE_KINDS)}

    def key(rel: str) -> tuple:
        if "/" in rel:
            return (0, rel)
        kind, ext = rel.rsplit(".", 1)
        if ext == "md":
            return (1, kind_rank[kind])
        return (3 if kind == "summary" else 2, kind_rank[kind])

    return sorted(manifest.files, key=key)


def _read_manifest(folder: Path) -> SiteManifest | None:
    try:
        return SiteManifest.from_json((folder / MANIFEST_NAME).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def deploy_site(src: Path, dest: Path) -> list[str]:
    """Copy the site built in `src` to the publish folder `dest`; returns the paths written, in order.

    `dest` is typically an rclone WebDAV mount: no Path.resolve(), no renames, one write per file.
    Every source file is checked against the source manifest before `dest` is touched. Files the
    previous deploy wrote with the same hash (and that still exist) are not rewritten. The manifest
    is written last; then files listed by the PREVIOUS manifest but not the new one are deleted.
    Nothing a manifest never listed is deleted.
    """
    src, dest = Path(src), Path(dest)
    manifest_bytes = (src / MANIFEST_NAME).read_bytes()
    manifest = SiteManifest.from_json(manifest_bytes.decode("utf-8"))
    order = _deploy_order(manifest)
    for rel in order:
        if _sha256((src / rel).read_bytes()) != manifest.files[rel]:
            raise ValueError(f"{src / rel} does not match the site manifest")

    previous = _read_manifest(dest)
    dest.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for rel in order:
        target = dest.joinpath(*rel.split("/"))
        if previous and previous.files.get(rel) == manifest.files[rel] and target.is_file():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((src / rel).read_bytes())
        written.append(rel)
    (dest / MANIFEST_NAME).write_bytes(manifest_bytes)
    written.append(MANIFEST_NAME)

    if previous:
        parents: set[Path] = set()
        for rel in sorted(set(previous.files) - set(manifest.files)):
            target = dest.joinpath(*rel.split("/"))
            target.unlink(missing_ok=True)
            if target.parent != dest:
                parents.add(target.parent)
        for folder in sorted(parents):
            try:
                folder.rmdir()  # only succeeds when nothing else is left in it
            except OSError:
                pass
    return written
