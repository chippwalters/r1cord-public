"""Stage summary.md + photos and drive MD DOCS Save-As + publish."""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from pathlib import Path


class PublishError(Exception):
    """MD DOCS publish step failed. summary.md in outbox is left untouched."""


def _win(path: Path) -> str:
    """Windows-native backslash path for bridge parameters (no resolve(): WebDAV mounts raise WinError 1005)."""
    return os.path.abspath(str(path)).replace("/", "\\")


def publish(
    summary_md: Path,
    photos_dir: Path,
    publish_folder: Path,
    *,
    theme: str,
    bridge,
    log: Callable[[str], None],
) -> Path:
    """Stage, drive the MD DOCS bridge, return publish_folder/summary.html."""
    summary_md = Path(summary_md)
    photos_dir = Path(photos_dir)
    publish_folder = Path(publish_folder)
    if not summary_md.is_file():
        raise PublishError(f"summary.md not found: {summary_md}")
    if not photos_dir.is_dir():
        raise PublishError(f"photos dir not found: {photos_dir}")

    stage_dir = summary_md.parent / "publish"
    stage_dir.mkdir(parents=True, exist_ok=True)
    staged_md = stage_dir / "summary.md"
    shutil.copy2(summary_md, staged_md)
    staged_photos = stage_dir / "photos"
    if staged_photos.exists():
        shutil.rmtree(staged_photos)
    shutil.copytree(photos_dir, staged_photos)
    log(f"publish: staged {staged_md} and {staged_photos}")

    try:
        bridge.ensure_running()
    except Exception as exc:
        raise PublishError(f"MD DOCS bridge is not running: {exc}") from exc

    publish_folder.mkdir(parents=True, exist_ok=True)

    steps: list[tuple[str, dict]] = [
        ("open_project", {"folderPath": _win(publish_folder)}),
        ("load_file", {"filePath": _win(staged_md)}),
        ("refresh_file", {}),
        ("set_theme", {"theme": theme}),
        ("save_file_as", {"filePath": _win(publish_folder / "summary.md")}),
        ("publish", {}),
    ]
    for action, params in steps:
        log(f"publish: {action} {params}")
        try:
            bridge.call(action, params)
        except Exception as exc:
            raise PublishError(f"{action}: {exc}") from exc

    html = publish_folder / "summary.html"
    if not html.is_file():
        raise PublishError(f"MD DOCS did not write {html}")
    log(f"publish: wrote {html}")
    return html
