"""A recording's pages: built from its outbox Markdown into `outbox/<rid>/site/`, deployed to its
publish folder, and the one-off republish of every published recording.

The site is the unit: every page whose source exists is built together, in the configured theme,
whether or not the recording is published. The admin serves that same build as the local view.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from .. import naming, render
from ..config import PAGE_KINDS, PAGE_LABELS, Config
from .writers import transcript_markdown

SITE_DIR = "site"
# The old MD DOCS publish step staged copies of the Markdown and photos here.
_LEGACY_STAGE_DIR = "publish"
# One build or deploy at a time: the worker and a republish never write the same site or folder at once.
SITE_LOCK = threading.RLock()

_log = logging.getLogger("r1cord_server.publish")


class PublishError(Exception):
    """Building or deploying a recording's site failed. The outbox Markdown is left untouched."""


def source_kinds(outbox: Path) -> list[str]:
    """Kinds that have a page source in the outbox, in page order. The transcript page can also be
    made from transcript.txt alone (recordings from before transcript.md)."""
    outbox = Path(outbox)
    return [
        kind
        for kind in PAGE_KINDS
        if (outbox / f"{kind}.md").is_file() or (kind == "transcript" and (outbox / "transcript.txt").is_file())
    ]


def page_sources(outbox: Path, title: str) -> list[render.PageSource]:
    """`transcript.md` and every `<kind>.md` in the outbox, in page order."""
    outbox = Path(outbox)
    pages = []
    for kind in source_kinds(outbox):
        md = outbox / f"{kind}.md"
        if md.is_file():
            text = md.read_text(encoding="utf-8")
        else:
            text = transcript_markdown(title, "", (outbox / "transcript.txt").read_text(encoding="utf-8"))
        pages.append(render.PageSource(kind=kind, label=PAGE_LABELS[kind], markdown=text))
    return pages


def build(outbox: Path, *, title: str, theme: str) -> render.SiteManifest:
    """(Re)build `outbox/site/` from the outbox sources and photos. Call under SITE_LOCK."""
    outbox = Path(outbox)
    pages = page_sources(outbox, title)
    if not pages:
        raise PublishError("nothing to publish (no transcript or AI review yet)")
    photos = outbox / "photos"
    manifest = build_into(
        outbox / SITE_DIR, pages, title=title, photos_dir=photos if photos.is_dir() else None, theme=theme
    )
    shutil.rmtree(outbox / _LEGACY_STAGE_DIR, ignore_errors=True)
    return manifest


def build_into(
    dest: Path, pages: list[render.PageSource], *, title: str, photos_dir: Path | None, theme: str
) -> render.SiteManifest:
    """Build into a temporary sibling, check every file the manifest names is there, then swap it
    in: a site that is being served or deployed is never half-written."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}-new-{uuid.uuid4().hex[:8]}")
    try:
        try:
            manifest = render.build_site(pages, title=title, photos_dir=photos_dir, theme=theme, dest=tmp)
        except (OSError, ValueError) as exc:
            raise PublishError(f"site build failed: {exc}") from exc
        missing = [rel for rel in manifest.files if not (tmp / rel).is_file()]
        if missing:
            raise PublishError(f"site build is missing {', '.join(sorted(missing)[:3])}")
        _swap(tmp, dest)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return manifest


def _swap(new: Path, dest: Path) -> None:
    old = dest.with_name(f".{dest.name}-old-{uuid.uuid4().hex[:8]}")
    # A file being served right now keeps its folder from being renamed on Windows; that lasts ms.
    for attempt in range(5):
        try:
            if dest.exists():
                os.replace(dest, old)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.1)
    try:
        os.replace(new, dest)
    except OSError:
        if old.exists():
            os.replace(old, dest)
        raise
    shutil.rmtree(old, ignore_errors=True)


def deploy(site: Path, publish_folder: Path, log: Callable[[str], None]) -> list[str]:
    """Copy a built site into its publish folder; logs every file written. Call under SITE_LOCK."""
    folder = Path(publish_folder)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        written = render.deploy_site(Path(site), folder)
    except Exception as exc:
        raise PublishError(f"deploy to {folder} failed: {exc}") from exc
    for rel in written:
        log(f"publish: wrote {rel}")
    return written


# --- Republish every published recording -------------------------------------------------------


def legacy_artifacts(folder: Path | str, kinds: Iterable[str]) -> list[str]:
    """What an MD DOCS export left beside each page the new site rewrites: `<kind>.css` and the
    `<kind>_images/` folder Save As copied linked files into. Names as on disk; folders end in "/"."""
    try:
        names = {name.lower(): name for name in os.listdir(folder)}
    except OSError:
        return []
    found: list[str] = []
    for kind in kinds:
        css = names.get(f"{kind}.css")
        if css is not None and os.path.isfile(os.path.join(folder, css)):
            found.append(css)
        images = names.get(f"{kind}_images")
        if images is not None and os.path.isdir(os.path.join(folder, images)):
            found.append(f"{images}/")
    return found


@dataclass(frozen=True)
class RepublishItem:
    recording_id: str
    title: str
    folder: str
    pages: tuple[str, ...]
    legacy: tuple[str, ...]
    skip: str = ""  # why the recording is left alone; "" = it is republished


@dataclass
class RepublishResult:
    recording_id: str
    title: str
    folder: str
    pages: tuple[str, ...] = ()
    written: int = 0
    removed: list[str] = field(default_factory=list)
    skip: str = ""
    error: str = ""


def plan_republish(store, config: Config) -> list[RepublishItem]:
    """Every recording whose latest publish folder exists: the pages its outbox sources would
    write there and the MD DOCS leftovers that would go. Reads only; never creates a folder."""
    outbox_root = Path(config.datastore) / "outbox"
    items: list[RepublishItem] = []
    for job, _runs in store.latest_jobs(limit=1_000_000):
        folder = job.publish_folder
        if not folder or not os.path.isdir(folder):
            continue
        title = job.title or job.recording_id
        if not naming.in_publish_root(config, folder):
            items.append(RepublishItem(job.recording_id, title, folder, (), (), "outside the publish folder"))
            continue
        kinds = tuple(source_kinds(outbox_root / job.recording_id))
        if not kinds:
            items.append(RepublishItem(job.recording_id, title, folder, (), (), "no transcript or AI review on this PC"))
            continue
        skip = "a job is running for it" if store.active_job_for(job.recording_id) is not None else ""
        items.append(RepublishItem(job.recording_id, title, folder, kinds, tuple(legacy_artifacts(folder, kinds)), skip))
    return items


def republish_one(store, config: Config, item: RepublishItem, log: Callable[[str], None]) -> RepublishResult:
    """Rebuild one recording's site, deploy it, then remove only the legacy files it replaced."""
    result = RepublishResult(item.recording_id, item.title, item.folder, item.pages, skip=item.skip)
    if item.skip:
        return result
    outbox = Path(config.datastore) / "outbox" / item.recording_id
    try:
        with SITE_LOCK:
            if store.active_job_for(item.recording_id) is not None:
                result.skip = "a job is running for it"
                return result
            manifest = build(outbox, title=item.title, theme=config.theme)
            result.pages = tuple(manifest.pages)
            result.written = len(deploy(outbox / SITE_DIR, Path(item.folder), log))
            managed = {rel.lower() for rel in manifest.files}
            for name in legacy_artifacts(item.folder, manifest.pages):
                if name.rstrip("/").lower() in managed:
                    continue
                target = os.path.join(item.folder, name.rstrip("/"))
                if name.endswith("/"):
                    shutil.rmtree(target)
                else:
                    os.remove(target)
                result.removed.append(name)
                log(f"republish: removed {name}")
    except (PublishError, OSError) as exc:
        result.error = str(exc)
    return result


class Republisher:
    """Runs one republish of every published recording on its own thread; keeps the last results."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.theme = ""
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.results: list[RepublishResult] = []
        self.error = ""

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, store, config: Config) -> bool:
        """False when a republish is already running."""
        with self._lock:
            if self.running:
                return False
            self.theme = config.theme
            self.started_at = time.time()
            self.finished_at = None
            self.results = []
            self.error = ""
            self._thread = threading.Thread(
                target=self._run, args=(store, config), name="r1cord-republish", daemon=True
            )
            self._thread.start()
            return True

    def wait(self, timeout: float | None = None) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _run(self, store, config: Config) -> None:
        try:
            for item in plan_republish(store, config):
                lines: list[str] = []
                result = republish_one(store, config, item, lines.append)
                self.results.append(result)
                if result.skip:
                    continue
                summary = (
                    f"republish: failed: {result.error}"
                    if result.error
                    else f"republish: {config.theme}, wrote {result.written} files"
                    + (f", removed {', '.join(result.removed)}" if result.removed else "")
                )
                _log.info("%s %s", item.recording_id, summary)
                latest = store.latest_for(item.recording_id)
                if latest is not None:
                    for line in [*lines, summary]:
                        store.append_log(latest.job_id, line)
        except Exception as exc:
            _log.exception("republish crashed")
            self.error = str(exc)
        finally:
            self.finished_at = time.time()
