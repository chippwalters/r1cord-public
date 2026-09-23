"""Local admin UI: recordings, devices, settings, system, job pages. HTTP Basic through a proxy."""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .auth import is_local_direct, require_admin
from .config import RUN_MODES, USB_ACTIONS, Config, save, with_updates
from .desktop import reveal_in_explorer
from .store import AUDIO_NAMES, RetryNotAllowed, StoreError
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
    "default_summary_style",
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


def _mddocs_status() -> tuple[str, str]:
    try:
        from .mddocs import MdDocsBridge

        bridge = MdDocsBridge()
        ok = bool(bridge.health())
        port = str(bridge.port())
        return ("reachable" if ok else "not reachable", port)
    except Exception:
        return ("unavailable", "unavailable")


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
        checks.append(_check("Summary writer", "off", "Summaries are off (default_writer = none)"))
    else:
        name = _WRITER_NAMES[config.default_writer]
        found = _cli_status(writer_cmds[config.default_writer])
        if found == "not found":
            checks.append(_check("Summary writer", "warn", f"{name} not found ({writer_cmds[config.default_writer]})"))
        else:
            checks.append(_check("Summary writer", "ok", f"{name} · {found}"))
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

    md_health, md_port = _mddocs_status()
    if md_health == "reachable":
        checks.append(_check("Publishing (MD DOCS)", "ok", f"Running · bridge port {md_port}"))
    else:
        checks.append(_check("Publishing (MD DOCS)", "off", "Not running — started automatically when a page is published"))
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
        rows.append(
            {
                "job": job,
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
            if path.is_file():
                files.append(path.relative_to(outbox).as_posix())
    active = rec.status not in {"complete", "error"}
    return _templates(
        request,
        "job.html",
        job=rec,
        job_id=job_id,
        result=result,
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
) -> RedirectResponse:
    chosen = writer.strip() or None
    try:
        request.app.state.store.retry_writer(job_id, chosen)
    except (RetryNotAllowed, StoreError) as exc:
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
    return _templates(request, "config.html", saved=False, restart_note=False, gws_path=_gws_path(request))


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
    default_summary_style: Annotated[str, Form()] = "",
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
        "default_summary_style": default_summary_style.strip() or old.default_summary_style,
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
    return _templates(request, "config.html", saved=True, restart_note=restart, gws_path=_gws_path(request))


@router.get("/admin/import", response_class=HTMLResponse)
def import_page(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    error: str | None = None,
    job_id: str | None = None,
) -> HTMLResponse:
    return _templates(request, "import.html", error=error, job_id=job_id)


@router.post("/admin/import", response_model=None)
def import_submit(
    request: Request,
    _admin: Annotated[str, Depends(require_admin)],
    folder: Annotated[str, Form()],
    title: Annotated[str, Form()] = "",
    summary_style: Annotated[str, Form()] = "notes",
    summarize: Annotated[str, Form()] = "",
    publish: Annotated[str, Form()] = "",
) -> RedirectResponse | HTMLResponse:
    store = request.app.state.store
    do_sum = summarize.lower() in {"1", "on", "true", "yes"}
    do_pub = publish.lower() in {"1", "on", "true", "yes"}
    try:
        rec = store.import_folder(
            Path(folder.strip()),
            title=title.strip() or None,
            summarize=do_sum,
            publish=do_pub,
            style=summary_style.strip() or request.app.state.config.default_summary_style,
        )
    except Exception as exc:
        return _templates(request, "import.html", error=str(exc), job_id=None)
    return RedirectResponse(url=f"/admin/jobs/{rec.job_id}", status_code=303)
