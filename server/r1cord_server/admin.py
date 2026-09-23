"""Local admin UI: recordings, devices, settings, system, job pages. HTTP Basic through a proxy."""

from __future__ import annotations

import json
import logging
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .auth import is_local_direct, require_admin
from . import naming, render
from .config import (
    PAGE_KINDS,
    PAGE_LABELS,
    PAGE_SHORT_LABELS,
    REVIEW_KINDS,
    RUN_MODES,
    USB_ACTIONS,
    Config,
    save,
    with_updates,
)
from .desktop import reveal_in_explorer
from .pipeline import instructions, publish
from .store import AUDIO_NAMES, JobRecord, RetryNotAllowed, StoreError
from .usb import UsbWatcher

router = APIRouter()
log = logging.getLogger("r1cord_server.admin")
TEMPLATES = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))

_EDITABLE = (
    "server_name",
    "listen_host",
    "listen_port",
    "webdav_folder",
    "public_url_base",
    "theme",
    "default_writer",
    "default_reviews",
    "writer_timeout_s",
    "claude_cmd",
    "codex_cmd",
    "grok_cmd",
    "asr_model",
    "asr_device",
    "asr_language",
    "pair_code_ttl_s",
    "usb_enabled",
    "adb_cmd",
    "usb_poll_s",
    "usb_auto_action",
    "usb_device_root",
    "run_mode",
    "idle_exit_min",
    "email_enabled",
    "email_to",
    "gws_cmd",
)
_PROCESSING = {
    "queued",
    "transcribing",
    "transcribed",
    "writing",
    "written",
    "publishing",
}


def _templates(request: Request, name: str, **context: Any) -> HTMLResponse:
    context.setdefault("request", request)
    context.setdefault("config", request.app.state.config)
    context.setdefault("refresh", False)
    return TEMPLATES.TemplateResponse(request, name, context)


def _cli_status(cmd: str) -> str:
    path = Path(cmd)
    if path.is_file():
        return str(path)
    found = shutil.which(cmd)
    return found or "not found"


def _gpu_status() -> str:
    try:
        import ctranslate2  # type: ignore[import-not-found]

        n = int(ctranslate2.get_cuda_device_count())
        return f"yes ({n} device(s))" if n else "no (0 devices)"
    except Exception as exc:
        return f"unavailable ({exc})"


_WRITER_NAMES = {"claude_code": "Claude Code", "codex": "Codex", "grok_build": "Grok Build"}
LOW_DISK_BYTES = 5 * 1024**3


def _check(name: str, state: str, detail: str) -> dict[str, str]:
    """One System row. state: ok (working), warn (needs attention), off (not in use)."""
    return {"name": name, "state": state, "detail": detail}


def _checks(config: Config) -> list[dict[str, str]]:
    """What the server depends on, in the order a problem would hurt."""
    from .mailer import gws_executable

    checks: list[dict[str, str]] = []
    gpu = _gpu_status()
    if gpu.startswith("yes"):
        checks.append(_check("Speech recognition", "ok", f"GPU (CUDA) · {config.asr_model}"))
    elif gpu.startswith("no"):
        checks.append(_check("Speech recognition", "ok", f"CPU · {config.asr_model} — slower than a GPU"))
    else:
        checks.append(_check("Speech recognition", "warn", f"Speech runtime not loaded: {gpu}"))

    writer_cmds = {"claude_code": config.claude_cmd, "codex": config.codex_cmd, "grok_build": config.grok_cmd}
    if config.default_writer == "none":
        checks.append(_check("AI reviews writer", "off", "AI reviews are off (default_writer = none)"))
    else:
        name = _WRITER_NAMES[config.default_writer]
        found = _cli_status(writer_cmds[config.default_writer])
        if found == "not found":
            checks.append(_check("AI reviews writer", "warn", f"{name} not found ({writer_cmds[config.default_writer]})"))
        else:
            checks.append(_check("AI reviews writer", "ok", f"{name} · {found}"))
    others = [
        f"{_WRITER_NAMES[key]} {'found' if _cli_status(cmd) != 'not found' else 'not installed'}"
        for key, cmd in writer_cmds.items()
        if key != config.default_writer
    ]
    checks.append(_check("Other writers", "off", " · ".join(others)))

    if not config.usb_enabled:
        checks.append(_check("USB mode", "off", "Off — recordings arrive only by Send"))
    else:
        adb = UsbWatcher.adb_path(config)
        checks.append(
            _check("USB mode", "ok", f"adb · {adb}") if adb else _check("USB mode", "warn", f"adb not found ({config.adb_cmd})")
        )

    try:
        checks.append(_check("Page theme", "ok", render.get_theme(config.theme).name))
    except ValueError:
        checks.append(_check("Page theme", "warn", f"Unknown theme: {config.theme}"))
    webdav = Path(config.webdav_folder)
    checks.append(
        _check("Publish folder", "ok", str(webdav))
        if webdav.is_dir()
        else _check("Publish folder", "warn", f"Missing: {webdav}")
    )

    if not config.email_enabled:
        checks.append(_check("Email", "off", "Off"))
    elif not config.email_to.strip():
        checks.append(_check("Email", "warn", "On, but no recipient is set (email_to)"))
    elif gws_executable(config.gws_cmd) is None:
        checks.append(_check("Email", "warn", f"On, but gws was not found ({config.gws_cmd})"))
    else:
        checks.append(_check("Email", "ok", f"To {config.email_to.strip()} via gws"))

    try:
        free = shutil.disk_usage(Path(config.datastore)).free
        checks.append(
            _check("Storage", "ok" if free >= LOW_DISK_BYTES else "warn", f"{_human_size(free)} free · {config.datastore}")
        )
    except OSError as exc:
        checks.append(_check("Storage", "warn", f"Cannot read {config.datastore}: {exc}"))
    return checks


_STATUS_VIEW = {
    "complete": ("Done", "ok"),
    "error": ("Failed", "bad"),
    "queued": ("Queued", "idle"),
    "uploading": ("Uploading", "work"),
    "transcribing": ("Transcribing", "work"),
    "transcribed": ("Transcribed", "work"),
    "writing": ("Writing", "work"),
    "written": ("Written", "work"),
    "publishing": ("Publishing", "work"),
    "published": ("Published", "work"),
}


def _status_view(status: str) -> tuple[str, str]:
    return _STATUS_VIEW.get(status, (status.capitalize(), "work"))


def _format_duration(ms: int) -> str:
    seconds = round(ms / 1000)
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def _duration(config: Config, recording_id: str) -> str:
    """Length from the device's metadata.json, else from the transcript; "" when neither says."""
    root = Path(config.datastore)
    for path in (root / "inbox" / recording_id / "metadata.json", root / "outbox" / recording_id / "transcript.json"):
        try:
            ms = int(json.loads(path.read_text(encoding="utf-8")).get("durationMs") or 0)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        if ms > 0:
            return _format_duration(ms)
    return ""


def _local_time(iso: str) -> str:
    """A stored UTC timestamp as this PC's local time, e.g. "Sep 23 · 11:48"."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return iso
    return f"{dt:%b} {dt.day} · {dt:%H:%M}"


TEMPLATES.env.filters["localtime"] = lambda iso: _local_time(iso) if iso else "never"


def _elapsed(updated_at: str) -> str:
    try:
        dt = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        seconds = int((datetime.now(timezone.utc) - dt).total_seconds())
        if seconds < 60:
            return f"{seconds}s"
        minutes, seconds = divmod(seconds, 60)
        if minutes < 60:
            return f"{minutes}m {seconds}s"
        hours, minutes = divmod(minutes, 60)
        return f"{hours}h {minutes}m"
    except ValueError:
        return "?"


def _running(store: Any) -> dict[str, Any] | None:
    for rec in store.recent_jobs(50):
        if rec.status in _PROCESSING and rec.status != "queued":
            lines = store.read_log(rec.job_id, tail=1)
            return {
                "job": rec,
                "elapsed": _elapsed(rec.updated_at),
                "last_log": lines[-1] if lines else "",
            }
    return None


def apply_config(app: Any, new_config: Config) -> None:
    """Save config.toml and swap the live config into every component that holds one."""
    path = getattr(app.state, "config_path", Path(new_config.datastore) / "config.toml")
    save(new_config, path)
    app.state.config = new_config
    app.state.store.config = new_config
    app.state.worker.config = new_config


def _audio_file(config: Config, recording_id: str) -> Path | None:
    """The recording's audio in the inbox, or None. Rejects ids that would leave the inbox."""
    inbox = (Path(config.datastore) / "inbox").resolve()
    folder = (inbox / recording_id).resolve()
    if folder.parent != inbox:
        return None
    for name in sorted(AUDIO_NAMES):
        path = folder / name
        if path.is_file():
            return path
    return None


def _outbox_folder(config: Config, recording_id: str) -> Path | None:
    """The recording's outbox folder (not created), or None for an id that would leave outbox/."""
    root = (Path(config.datastore) / "outbox").resolve()
    folder = (root / recording_id).resolve()
    return folder if folder.parent == root else None


def _source_kinds(outbox: Path | None) -> list[str]:
    return publish.source_kinds(outbox) if outbox is not None else []


def _page_links(config: Config, job: JobRecord) -> list[dict[str, Any]]:
    """Transcript / Summary / Outline / Organized for a recording, each with its Markdown: the
    published `<kind>.html` / `<kind>.md` when they are in its publish folder, else the site built
    on this PC (`local`)."""
    published = naming.published_files(config, job.publish_folder)
    local = _source_kinds(_outbox_folder(config, job.recording_id))
    site = f"/admin/site/{quote(job.recording_id, safe='')}/"
    links = []
    for kind in PAGE_KINDS:
        page = published.get(f"{kind}.html")
        if page is None and kind not in local:
            continue
        md = published.get(f"{kind}.md")
        links.append(
            {
                "kind": kind,
                "label": PAGE_SHORT_LABELS[kind],
                "url": page or f"{site}{kind}.html",
                "local": page is None,
                "md_url": md or (f"{site}{kind}.md" if kind in local else None),
                "md_local": md is None,
            }
        )
    return links


def _review_choices(config: Config, recording_id: str) -> list[dict[str, str]]:
    """The Add review menu: each kind labelled Write, or Rewrite when it already exists."""
    existing = _source_kinds(_outbox_folder(config, recording_id))
    return [
        {"kind": kind, "label": PAGE_LABELS[kind], "verb": "Rewrite" if kind in existing else "Write"}
        for kind in REVIEW_KINDS
    ]


def _human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    raise AssertionError("unreachable")


def _local_only(request: Request) -> HTMLResponse | None:
    """Show in folder acts on this PC's desktop; never on behalf of a tunnel or proxy caller."""
    if is_local_direct(request):
        return None
    return HTMLResponse("Only available on the server PC itself.", status_code=403)


@router.get("/admin", response_class=HTMLResponse)
def dashboard(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    store = request.app.state.store
    config = request.app.state.config
    usb = request.app.state.usb.status()
    rows = []
    queued = 0
    for job, runs in store.latest_jobs(100):
        audio = _audio_file(config, job.recording_id)
        label, tone = _status_view(job.status)
        queued += job.status == "queued"
        outbox = _outbox_folder(config, job.recording_id)
        rows.append(
            {
                "job": job,
                "pages": _page_links(config, job),
                "reviews": _review_choices(config, job.recording_id),
                "has_transcript": outbox is not None and (outbox / "transcript.txt").is_file(),
                "runs": runs,
                "duration": _duration(config, job.recording_id),
                "size": _human_size(audio.stat().st_size) if audio else "",
                "has_audio": audio is not None,
                "status_label": label,
                "status_tone": tone,
                "updated": _local_time(job.updated_at),
            }
        )
    running = _running(store)
    adopted = [model or serial for serial, model, is_adopted in usb.connected if is_adopted]
    issues = [c for c in _checks(config) if c["state"] == "warn"]
    return _templates(
        request,
        "dashboard.html",
        rows=rows,
        running=running,
        running_label=_status_view(running["job"].status)[0] if running else "",
        queued=queued,
        usb=usb,
        device=adopted[0].replace("_", " ") if adopted else "",
        issues=issues,
        local=is_local_direct(request),
        notice=request.query_params.get("notice"),
        deleted=request.query_params.get("deleted"),
        # Keep the page current while something is moving; a still dashboard never reloads.
        refresh=running is not None or queued > 0 or usb.syncing is not None,
    )


@router.get("/admin/system", response_class=HTMLResponse)
def system_page(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    store = request.app.state.store
    config: Config = request.app.state.config
    recent = store.recent_jobs(1)
    server_version = _server_version()
    return _templates(
        request,
        "system.html",
        checks=_checks(config),
        last_job=_local_time(recent[0].updated_at) if recent else "never",
        server_version=server_version,
        config_path=getattr(request.app.state, "config_path", ""),
    )


def _server_version() -> str:
    """The version in the pyproject.toml shipped beside the package (the install is editable, so
    installed metadata goes stale after an update); package metadata as a fallback."""
    try:
        import tomllib

        pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
        return str(tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"])
    except (OSError, KeyError, ValueError):
        pass
    try:
        from importlib.metadata import version

        return version("r1cord-server")
    except Exception:
        return "unknown"


@router.post("/admin/recordings/{recording_id}/delete")
def recording_delete(
    recording_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse:
    try:
        request.app.state.store.delete_recording(recording_id)
    except (StoreError, ValueError) as exc:
        log.warning("delete %s refused: %s", recording_id, exc)
        return RedirectResponse(url=f"/admin?notice={quote(f'Could not delete {recording_id}: {exc}')}", status_code=303)
    return RedirectResponse(url=f"/admin?deleted={quote(recording_id)}", status_code=303)


@router.get("/admin/recordings/{recording_id}/audio", response_model=None)
def recording_audio(
    recording_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> FileResponse | HTMLResponse:
    path = _audio_file(request.app.state.config, recording_id)
    if path is None:
        return HTMLResponse("no audio for this recording", status_code=404)
    return FileResponse(path, filename=f"{recording_id}{path.suffix}")


@router.post("/admin/recordings/{recording_id}/folder", response_model=None)
def recording_folder(
    recording_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse | HTMLResponse:
    denied = _local_only(request)
    if denied is not None:
        return denied
    path = _audio_file(request.app.state.config, recording_id)
    if path is None:
        return HTMLResponse("no audio for this recording", status_code=404)
    reveal_in_explorer(path)
    return RedirectResponse(url="/admin#recordings", status_code=303)


# The pages carry their own CSP meta tag (with their theme's font hosts); this header is the outer
# bound, and the one thing a meta tag cannot say: only the admin itself may frame them.
_SITE_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; img-src 'self' data:; style-src 'self' https:; font-src 'self' https: data:; "
        "script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
}
_SITE_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
}


def _site_file(root: Path, name: str) -> FileResponse | HTMLResponse:
    """A file of a built site under `root` (resolved), never anything outside it."""
    target = (root / name).resolve()
    if root not in target.parents:
        log.info("site: rejected %r", name)
        return HTMLResponse("invalid path", status_code=400)
    if not target.is_file():
        return HTMLResponse("not found", status_code=404)
    return FileResponse(
        target,
        media_type=_SITE_TYPES.get(target.suffix.lower(), "application/octet-stream"),
        headers=dict(_SITE_HEADERS),
    )


def _page_kind(name: str) -> str | None:
    """The page kind a site file name is ("summary" for summary.html or summary.md); None for other files."""
    kind, dot, ext = name.rpartition(".")
    return kind if dot and ext in ("html", "md") and kind in PAGE_KINDS else None


@router.get("/admin/site/{recording_id}/{name:path}", response_model=None)
def admin_site(
    recording_id: str,
    name: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> FileResponse | HTMLResponse:
    """The recording's site as built on this PC: the pages exactly as they are (or would be) published."""
    config: Config = request.app.state.config
    outbox = _outbox_folder(config, recording_id)
    if outbox is None:
        log.info("site: rejected %r", recording_id)
        return HTMLResponse("invalid path", status_code=400)
    site = outbox / publish.SITE_DIR
    kind = _page_kind(name)
    # A recording from before sites existed (or whose last build failed) is built on first view.
    if kind is not None and not (site / name).is_file() and kind in _source_kinds(outbox):
        rec = request.app.state.store.latest_for(recording_id)
        try:
            with publish.SITE_LOCK:
                publish.build(outbox, title=(rec.title if rec else "") or recording_id, theme=config.theme)
        except (publish.PublishError, OSError, ValueError) as exc:
            log.warning("site: %s: build failed: %s", recording_id, exc)
    return _site_file(site, name)


_SAMPLE_TITLE = "Site visit, north lot"
_SAMPLE_PAGES = {
    "transcript": """\
# Site visit, north lot

*2026-09-20 16:15 · 4:12*

Okay, we're at the north lot. The gate on the east side is sticking again, it needs new hinges.

The drainage by the loading dock looks better since the regrade, but there's still standing water after rain.
""",
    "summary": """\
# Site visit, north lot

A walk around the north lot to check the east gate and the drainage after last month's regrade.
The gate needs new hinges; the drainage is better but not fixed.

## Key points

- The **east gate** sticks and needs new hinges.
- Drainage by the loading dock improved after the regrade.
- Standing water still collects after heavy rain.

## Action items

- [ ] Order two heavy-duty hinges for the east gate.
- [ ] Ask the contractor about a second drain near the dock.
- [x] Photograph the dock after the next storm.

| Area | Status | Next step |
| --- | --- | --- |
| East gate | Sticking | New hinges |
| Loading dock | Better | Second drain |

> "It's better, but it's not done."
""",
    "outline": """\
# Site visit, north lot

- East gate
    - Sticks when opened
    - Needs new hinges
- Drainage
    - Better since the regrade
    - Standing water after rain
""",
    "organized": """\
# Site visit, north lot

## East gate

The gate on the east side is sticking again. It needs new hinges.

## Drainage

The drainage by the loading dock is better since the regrade, but water still stands there after rain.
""",
}
# Sample sites already built by this process, by folder; the renderer only changes with the code.
_PREVIEWS: set[Path] = set()
_PREVIEW_LOCK = threading.Lock()


@router.get("/admin/theme-preview/{theme_id}/{name:path}", response_model=None)
def theme_preview(
    theme_id: str,
    name: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> FileResponse | HTMLResponse:
    """A sample recording's site in any theme, built on first request into the datastore's cache."""
    try:
        theme = render.get_theme(theme_id)
    except ValueError:
        return HTMLResponse("unknown theme", status_code=404)
    dest = (Path(request.app.state.config.datastore) / "cache" / "theme-preview" / theme.id).resolve()
    with _PREVIEW_LOCK:
        if dest not in _PREVIEWS or not dest.is_dir():
            pages = [
                render.PageSource(kind=kind, label=PAGE_LABELS[kind], markdown=text) for kind, text in _SAMPLE_PAGES.items()
            ]
            try:
                publish.build_into(dest, pages, title=_SAMPLE_TITLE, photos_dir=None, theme=theme.id)
            except publish.PublishError as exc:
                log.warning("theme preview %s: %s", theme.id, exc)
                return HTMLResponse(f"preview failed: {exc}", status_code=500)
            _PREVIEWS.add(dest)
    return _site_file(dest, name)


@router.post("/admin/recordings/{recording_id}/reviews")
def recording_add_review(
    recording_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    kind: Annotated[str, Form()] = "",
) -> RedirectResponse:
    """Write (or rewrite) one AI review from the existing transcript as a new job."""
    try:
        rec = request.app.state.store.add_review(recording_id, kind.strip())
    except (StoreError, ValueError) as exc:
        log.warning("add review %s/%s refused: %s", recording_id, kind, exc)
        return RedirectResponse(url=f"/admin?notice={quote(f'Could not add a review to {recording_id}: {exc}')}", status_code=303)
    return RedirectResponse(url=f"/admin/jobs/{rec.job_id}", status_code=303)


@router.post("/admin/usb/toggle")
def usb_toggle(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> RedirectResponse:
    old: Config = request.app.state.config
    apply_config(request.app, with_updates(old, usb_enabled=not old.usb_enabled))
    request.app.state.usb.poll_now()
    return RedirectResponse(url="/admin/devices", status_code=303)


@router.post("/admin/usb/poll")
def usb_poll(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> RedirectResponse:
    request.app.state.usb.poll_now()
    return RedirectResponse(url="/admin/devices", status_code=303)


@router.get("/admin/devices", response_class=HTMLResponse)
def devices_page(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    error: str | None = None,
) -> HTMLResponse:
    store = request.app.state.store
    usb = request.app.state.usb.status()
    connected = {serial: (model, adopted) for serial, model, adopted in usb.connected}
    known = store.devices()
    adopted = [
        {
            "info": d,
            "connected": d.serial in connected,
            "recordings": store.device_recordings(d.serial),
        }
        for d in known
        if d.adopted
    ]
    unknown = [
        {"serial": serial, "model": model}
        for serial, (model, is_adopted) in connected.items()
        if not is_adopted
    ]
    tokens = store.tokens()
    return _templates(
        request,
        "devices.html",
        usb=usb,
        adopted=adopted,
        unknown=unknown,
        actions=USB_ACTIONS[1:],
        error=error,
        paired=[t for t in tokens if not t.revoked],
        revoked=[t for t in tokens if t.revoked],
        refresh=usb.syncing is not None,
    )


@router.post("/admin/devices/{serial}/adopt")
def device_adopt(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    serial: str,
) -> RedirectResponse:
    request.app.state.store.adopt_device(serial)
    request.app.state.usb.poll_now()
    return RedirectResponse(url="/admin/devices", status_code=303)


@router.post("/admin/devices/{serial}/forget")
def device_forget(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    serial: str,
) -> RedirectResponse:
    request.app.state.store.forget_device(serial)
    return RedirectResponse(url="/admin/devices", status_code=303)


@router.post("/admin/devices/{serial}/recordings/{recording_id}/process")
def device_process(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    serial: str,
    recording_id: str,
    action: Annotated[str, Form()],
) -> RedirectResponse:
    store = request.app.state.store
    try:
        rec = store.process_inbox(recording_id, action=action.strip())
    except (StoreError, ValueError, OSError) as exc:
        log.warning("process %s/%s failed: %s", serial, recording_id, exc)
        return RedirectResponse(
            url=f"/admin/devices?error={quote(f'{recording_id}: {exc}')}", status_code=303
        )
    store.set_auto_job(serial, recording_id, rec.job_id)
    return RedirectResponse(url=f"/admin/jobs/{rec.job_id}", status_code=303)


@router.post("/admin/pair", response_class=HTMLResponse)
def generate_pair(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    store = request.app.state.store
    config = request.app.state.config
    code = store.create_pair_code()
    return _templates(
        request,
        "pairing.html",
        code=code,
        ttl_s=config.pair_code_ttl_s,
        server_name=config.server_name,
    )


@router.post("/admin/tokens/{token_id}/revoke")
def revoke_token(
    token_id: int,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse:
    request.app.state.store.revoke_token(token_id)
    return RedirectResponse(url="/admin/devices#paired", status_code=303)


@router.get("/admin/jobs/{job_id}", response_class=HTMLResponse)
def job_page(
    job_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> HTMLResponse:
    store = request.app.state.store
    notice = request.query_params.get("notice")
    sent = request.query_params.get("sent")
    rec = store.job(job_id)
    if rec is None:
        # notice/sent still render: an email or retry against a vanished job must explain itself.
        return _templates(request, "job.html", job=None, job_id=job_id, notice=notice, sent=sent)
    result = store.result_json(job_id)
    log_lines = store.read_log(job_id, tail=200)
    outbox = store.outbox_dir(rec.recording_id)
    files: list[str] = []
    if outbox.is_dir():
        for path in sorted(outbox.rglob("*")):
            top = path.relative_to(outbox).parts[0]
            # The built site is reached through the page links; a build's temporary folders never.
            if top == publish.SITE_DIR or top.startswith(f".{publish.SITE_DIR}-"):
                continue
            if path.is_file():
                files.append(path.relative_to(outbox).as_posix())
    active = rec.status not in {"complete", "error"}
    return _templates(
        request,
        "job.html",
        job=rec,
        job_id=job_id,
        result=result,
        labels=PAGE_LABELS,
        pages=_page_links(request.app.state.config, rec),
        review_kinds=REVIEW_KINDS,
        retry_reviews=rec.reviews or request.app.state.config.default_reviews,
        log_lines=log_lines,
        files=files,
        active=active,
        refresh=active,
        notice=notice,
        sent=sent,
    )


@router.post("/admin/jobs/{job_id}/email")
def admin_email_job(
    job_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse:
    from .mailer import MailError, email_job

    config: Config = request.app.state.config
    try:
        email_job(request.app.state.store, config, job_id)
    except (MailError, StoreError) as exc:
        log.warning("email for %s failed: %s", job_id, exc)
        return RedirectResponse(url=f"/admin/jobs/{job_id}?notice={quote(f'Email: {exc}')}", status_code=303)
    return RedirectResponse(url=f"/admin/jobs/{job_id}?sent={quote(config.email_to.strip())}", status_code=303)


@router.post("/admin/jobs/{job_id}/retry-writer")
def admin_retry_writer(
    job_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    writer: Annotated[str, Form()] = "",
    reviews: Annotated[list[str] | None, Form()] = None,
) -> RedirectResponse:
    chosen = writer.strip() or None
    # The form sends an empty marker entry, so "none ticked" differs from "field absent" (= the job's own).
    chosen_reviews = [k for k in reviews if k] if reviews is not None else None
    try:
        request.app.state.store.retry_writer(job_id, chosen, chosen_reviews)
    except (RetryNotAllowed, StoreError, ValueError) as exc:
        return RedirectResponse(
            url=f"/admin/jobs/{job_id}?notice={quote(str(exc))}",
            status_code=303,
        )
    return RedirectResponse(url=f"/admin/jobs/{job_id}", status_code=303)


@router.post("/admin/jobs/{job_id}/retry-publish")
def admin_retry_publish(
    job_id: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse:
    try:
        request.app.state.store.retry_publish(job_id)
    except (RetryNotAllowed, StoreError) as exc:
        return RedirectResponse(
            url=f"/admin/jobs/{job_id}?notice={quote(str(exc))}",
            status_code=303,
        )
    return RedirectResponse(url=f"/admin/jobs/{job_id}", status_code=303)


@router.get("/admin/files/{recording_id}/{name:path}", response_model=None)
def admin_file(
    recording_id: str,
    name: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> FileResponse | HTMLResponse:
    # Resolve both halves by hand: never mkdir for a hostile id, and never let either the
    # recording id or the file name step outside that recording's outbox folder.
    outbox_root = (Path(request.app.state.config.datastore) / "outbox").resolve()
    outbox = (outbox_root / recording_id).resolve()
    target = (outbox / name).resolve()
    if outbox.parent != outbox_root or (outbox != target and outbox not in target.parents):
        log.info("files: rejected %r / %r", recording_id, name)
        return HTMLResponse("invalid path", status_code=400)
    if not target.is_file():
        return HTMLResponse("not found", status_code=404)
    return FileResponse(target)

@router.get("/admin/config", response_class=HTMLResponse)
def config_page(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    return _config_page(request, saved=False, restart_note=False)


def _config_page(
    request: Request,
    *,
    saved: bool,
    restart_note: bool,
    theme_changed: bool = False,
    prompt_error: dict[str, str] | None = None,
    status_code: int = 200,
) -> HTMLResponse:
    prompts_dir: Path = request.app.state.prompts_dir
    prompts = []
    for kind in REVIEW_KINDS:
        failed = prompt_error is not None and prompt_error["kind"] == kind
        prompts.append(
            {
                "kind": kind,
                "label": PAGE_LABELS[kind],
                # A prompt that could not be saved comes back as typed, with the reason.
                "text": prompt_error["text"] if failed else instructions.load_prompt(prompts_dir, kind),
                "custom": instructions.is_custom(prompts_dir, kind),
                "error": prompt_error["message"] if failed else "",
            }
        )
    response = _templates(
        request,
        "config.html",
        saved=saved,
        restart_note=restart_note,
        gws_path=_gws_path(request),
        prompts=prompts,
        review_kinds=REVIEW_KINDS,
        labels=PAGE_LABELS,
        max_prompt_chars=instructions.MAX_PROMPT_CHARS,
        themes=render.list_themes(),
        theme_changed=theme_changed,
        prompt_saved=request.query_params.get("prompt_saved"),
        prompt_restored=request.query_params.get("prompt_restored"),
    )
    response.status_code = status_code
    return response


@router.post("/admin/prompts/{kind}", response_model=None)
def prompt_save(
    kind: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    prompt: Annotated[str, Form()] = "",
) -> RedirectResponse | HTMLResponse:
    if kind not in REVIEW_KINDS:
        return HTMLResponse("not found", status_code=404)
    try:
        instructions.save_prompt(request.app.state.prompts_dir, kind, prompt)
    except instructions.PromptError as exc:
        error = {"kind": kind, "message": str(exc), "text": prompt}
        return _config_page(request, saved=False, restart_note=False, prompt_error=error, status_code=400)
    return RedirectResponse(url=f"/admin/config?prompt_saved={kind}#prompt-{kind}", status_code=303)


@router.post("/admin/prompts/{kind}/restore", response_model=None)
def prompt_restore(
    kind: str,
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
) -> RedirectResponse | HTMLResponse:
    if kind not in REVIEW_KINDS:
        return HTMLResponse("not found", status_code=404)
    instructions.restore_prompt(request.app.state.prompts_dir, kind)
    return RedirectResponse(url=f"/admin/config?prompt_restored={kind}#prompt-{kind}", status_code=303)


def _gws_path(request: Request) -> str | None:
    from .mailer import gws_executable

    return gws_executable(request.app.state.config.gws_cmd)


@router.post("/admin/config", response_class=HTMLResponse)
def config_save(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    server_name: Annotated[str, Form()] = "",
    listen_host: Annotated[str, Form()] = "",
    listen_port: Annotated[int, Form()] = 8765,
    webdav_folder: Annotated[str, Form()] = "",
    public_url_base: Annotated[str, Form()] = "",
    theme: Annotated[str, Form()] = "",
    default_writer: Annotated[str, Form()] = "",
    default_reviews: Annotated[list[str] | None, Form()] = None,
    writer_timeout_s: Annotated[int, Form()] = 900,
    claude_cmd: Annotated[str, Form()] = "",
    codex_cmd: Annotated[str, Form()] = "",
    grok_cmd: Annotated[str, Form()] = "",
    asr_model: Annotated[str, Form()] = "",
    asr_device: Annotated[str, Form()] = "",
    asr_language: Annotated[str, Form()] = "",
    pair_code_ttl_s: Annotated[int, Form()] = 600,
    usb_enabled: Annotated[str, Form()] = "",
    adb_cmd: Annotated[str, Form()] = "",
    usb_poll_s: Annotated[int, Form()] = 3,
    usb_auto_action: Annotated[str, Form()] = "",
    usb_device_root: Annotated[str, Form()] = "",
    run_mode: Annotated[str, Form()] = "",
    idle_exit_min: Annotated[int, Form()] = 10,
    email_enabled: Annotated[str, Form()] = "",
    email_to: Annotated[str, Form()] = "",
    gws_cmd: Annotated[str, Form()] = "",
    new_admin_password: Annotated[str, Form()] = "",
) -> HTMLResponse:
    old: Config = request.app.state.config
    changes: dict[str, Any] = {
        "server_name": server_name.strip() or old.server_name,
        "listen_host": listen_host.strip() or old.listen_host,
        "listen_port": int(listen_port),
        "webdav_folder": Path(webdav_folder.strip() or str(old.webdav_folder)),
        "public_url_base": public_url_base.strip().rstrip("/") or old.public_url_base,
        "theme": theme.strip() or old.theme,
        "default_writer": default_writer.strip() or old.default_writer,
        # The form sends an empty marker entry, so "none ticked" (transcript only) differs from absent.
        "default_reviews": (
            [k for k in default_reviews if k in REVIEW_KINDS] if default_reviews is not None else old.default_reviews
        ),
        "writer_timeout_s": int(writer_timeout_s),
        "claude_cmd": claude_cmd.strip() or old.claude_cmd,
        "codex_cmd": codex_cmd.strip() or old.codex_cmd,
        "grok_cmd": grok_cmd.strip() or old.grok_cmd,
        "asr_model": asr_model.strip() or old.asr_model,
        "asr_device": asr_device.strip() or old.asr_device,
        "asr_language": asr_language,
        "pair_code_ttl_s": int(pair_code_ttl_s),
        "usb_enabled": usb_enabled == "on",
        "adb_cmd": adb_cmd.strip() or old.adb_cmd,
        "usb_poll_s": max(1, int(usb_poll_s)),
        "usb_auto_action": usb_auto_action.strip() or old.usb_auto_action,
        "usb_device_root": usb_device_root.strip().rstrip("/") or old.usb_device_root,
        "run_mode": run_mode.strip() or old.run_mode,
        "idle_exit_min": max(1, int(idle_exit_min)),
        "email_enabled": email_enabled == "on",
        "email_to": email_to.strip(),
        "gws_cmd": gws_cmd.strip() or old.gws_cmd,
    }
    try:
        render.get_theme(changes["theme"])
    except ValueError:
        changes["theme"] = old.theme
    if changes["usb_auto_action"] not in USB_ACTIONS:
        changes["usb_auto_action"] = old.usb_auto_action
    if changes["run_mode"] not in RUN_MODES:
        changes["run_mode"] = old.run_mode
    new_config = with_updates(old, **changes)
    rotated = new_admin_password.strip()
    if rotated:
        from dataclasses import replace

        new_config = replace(new_config, admin_password=rotated)
    apply_config(request.app, new_config)
    request.app.state.usb.poll_now()
    restart = (
        new_config.listen_host != old.listen_host or new_config.listen_port != old.listen_port
    )
    return _config_page(request, saved=True, restart_note=restart, theme_changed=new_config.theme != old.theme)


@router.post("/admin/republish", response_model=None)
def republish_start(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    dry_run: bool = False,
) -> RedirectResponse | HTMLResponse:
    """Rebuild every published recording's pages in the current theme and deploy them into its
    folder, removing the MD DOCS leftovers they replace. `dry_run` lists what would happen."""
    store = request.app.state.store
    config: Config = request.app.state.config
    if dry_run:
        return _templates(
            request, "republish.html", plan=publish.plan_republish(store, config), run=None,
            theme=render.get_theme(config.theme), labels=PAGE_SHORT_LABELS,
        )
    if not request.app.state.republish.start(store, config):
        return RedirectResponse(url=f"/admin/republish?notice={quote('A republish is already running.')}", status_code=303)
    return RedirectResponse(url="/admin/republish", status_code=303)


@router.get("/admin/republish", response_class=HTMLResponse)
def republish_status(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    run = request.app.state.republish
    return _templates(
        request, "republish.html", plan=None, run=run, theme=render.get_theme(run.theme or request.app.state.config.theme),
        labels=PAGE_SHORT_LABELS, notice=request.query_params.get("notice"), refresh=run.running,
    )


@router.get("/admin/import", response_class=HTMLResponse)
def import_page(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    error: str | None = None,
) -> HTMLResponse:
    return _import_page(request, error=error)


def _import_page(request: Request, *, error: str | None) -> HTMLResponse:
    return _templates(
        request, "import.html", error=error, review_kinds=REVIEW_KINDS, labels=PAGE_LABELS
    )


@router.post("/admin/import", response_model=None)
def import_submit(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    folder: Annotated[str, Form()],
    title: Annotated[str, Form()] = "",
    reviews: Annotated[list[str] | None, Form()] = None,
    publish: Annotated[str, Form()] = "",
) -> RedirectResponse | HTMLResponse:
    store = request.app.state.store
    do_pub = publish.lower() in {"1", "on", "true", "yes"}
    # The form sends an empty marker entry; a post without the field gets the default reviews.
    chosen = [k for k in reviews if k] if reviews is not None else request.app.state.config.default_reviews
    try:
        rec = store.import_folder(
            Path(folder.strip()),
            title=title.strip() or None,
            reviews=chosen,
            publish=do_pub,
        )
    except Exception as exc:
        return _import_page(request, error=str(exc))
    return RedirectResponse(url=f"/admin/jobs/{rec.job_id}", status_code=303)
