"""Publish-folder slug, collision suffix, and public WebDAV URL."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from .config import PAGE_KINDS, Config

_NON_SLUG = re.compile(r"[^a-z0-9]+")
_SLUG_MAX = 48


def slugify(title: str) -> str:
    s = _NON_SLUG.sub("-", title.strip().lower()).strip("-")
    if not s:
        return "recording"
    s = s[:_SLUG_MAX].rstrip("-")
    return s or "recording"


def publish_folder(
    config: Config,
    created_at_ms: int,
    title: str,
    recording_id: str,
    occupied: Iterable[tuple[str, str]] | None = None,
) -> Path:
    """`<webdav_folder>\\<YYYY>\\<MM>\\<YYYYMMDD-HHMM>-<slug>\\` in local time.

    If that folder already exists for a *different* recording id (on disk or in
    `occupied` as `(folder_path, recording_id)` pairs), append `-2`, `-3`, …
    The same recording id reuses its folder so the public URL stays stable.
    """
    dt = datetime.fromtimestamp(created_at_ms / 1000)
    year = dt.strftime("%Y")
    month = dt.strftime("%m")
    stamp = dt.strftime("%Y%m%d-%H%M")
    slug = slugify(title)
    parent = Path(config.webdav_folder) / year / month
    base_name = f"{stamp}-{slug}"

    occupied_map: dict[str, str] = {}
    for folder, owner in occupied or ():
        occupied_map[_norm(folder)] = owner

    n = 1
    while True:
        name = base_name if n == 1 else f"{base_name}-{n}"
        candidate = parent / name
        key = _norm(candidate)
        owner = occupied_map.get(key)
        if owner == recording_id:
            return candidate
        taken = owner is not None or candidate.exists()
        if not taken:
            return candidate
        n += 1


def webdav_url(config: Config, folder: Path, page: str) -> str:
    """`<public_url_base>/<YYYY>/<MM>/<folder>/<page>` with encoded segments, e.g. page `summary.html`.

    Lexical only: `Path.resolve()` raises WinError 1005 on the rclone WebDAV mount.
    Root matching is case-insensitive and boundary-aware (a sibling like `wd2`
    next to root `wd` is not under the root).
    """
    folder = Path(folder)
    root_parts = [_norm(p) for p in Path(config.webdav_folder).parts]
    folder_parts = [_norm(p) for p in folder.parts]
    if len(folder_parts) > len(root_parts) and folder_parts[: len(root_parts)] == root_parts:
        rel = Path(*folder.parts[len(root_parts):])
    else:
        rel = Path(*folder.parts[-3:])
    parts = [quote(p, safe="-_.") for p in rel.parts]
    base = config.public_url_base.rstrip("/")
    return f"{base}/{'/'.join(parts)}/{quote(page, safe="-_.")}"


def published_files(config: Config, folder: Path | str | None) -> dict[str, str]:
    """`{"<kind>.html" | "<kind>.md": url}` for each page file in a recording's publish folder.

    One directory listing, no resolve(): the folder usually sits on the rclone WebDAV mount.
    A missing or unreadable folder has no pages.
    """
    if not folder:
        return {}
    try:
        names = {name.lower() for name in os.listdir(folder)}
    except OSError:
        return {}
    return {
        name: webdav_url(config, Path(folder), name)
        for kind in PAGE_KINDS
        for name in (f"{kind}.html", f"{kind}.md")
        if name in names
    }


def published_pages(config: Config, folder: Path | str | None) -> list[dict[str, str]]:
    """`[{"kind", "url"}]` for every `<kind>.html` in a recording's publish folder, in page order."""
    files = published_files(config, folder)
    return [{"kind": kind, "url": files[f"{kind}.html"]} for kind in PAGE_KINDS if f"{kind}.html" in files]


def in_publish_root(config: Config, folder: Path | str) -> bool:
    """True when `folder` sits strictly inside `webdav_folder`: never the root itself, never outside it.
    Lexical (resolve() raises WinError 1005 on the rclone WebDAV mount)."""
    root = [_norm(p) for p in Path(os.path.abspath(config.webdav_folder)).parts]
    parts = [_norm(p) for p in Path(os.path.abspath(folder)).parts]
    return len(parts) > len(root) and parts[: len(root)] == root


def _norm(path: str | Path) -> str:
    return str(Path(path)).replace("/", "\\").lower()
