"""Local admin UI: dashboard, job, config, import. HTTP Basic, no JavaScript."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .auth import is_local_direct, require_admin
from .config import RUN_MODES, USB_ACTIONS, Config, save, with_updates
from .store import AUDIO_NAMES, RetryNotAllowed, StoreError, utcnow_iso
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


def _health(config: Config, store: Any) -> dict[str, str]:
    root = Path(config.datastore)
    try:
        free = shutil.disk_usage(root).free
        free_s = f"{free / (1024 ** 3):.1f} GB free"
    except OSError as exc:
        free_s = f"error ({exc})"
    webdav = Path(config.webdav_folder)
    recent = store.recent_jobs(1)
    last = recent[0].updated_at if recent else "never"
    md_health, md_port = _mddocs_status()
    return {
        "claude": _cli_status(config.claude_cmd),
        "codex": _cli_status(config.codex_cmd),
        "grok": _cli_status(config.grok_cmd),
        "adb": UsbWatcher.adb_path(config) or "not found",
        "gpu": _gpu_status(),
        "mddocs": md_health,
        "mddocs_port": md_port,
        "datastore_space": free_s,
        "webdav_exists": "yes" if webdav.is_dir() else "no",
        "last_job": last,
    }


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
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def _local_only(request: Request) -> HTMLResponse | None:
    """Play / Open folder act on this PC's desktop; never on behalf of a tunnel or proxy caller."""
    if is_local_direct(request):
        return None
    return HTMLResponse("Only available on the server PC itself.", status_code=403)


@router.get("/admin", response_class=HTMLResponse)
def dashboard(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> HTMLResponse:
    store = request.app.state.store
    config = request.app.state.config
    queue = [j for j in store.recent_jobs(50) if j.status == "queued"]
    # oldest queued first
    queue.sort(key=lambda j: j.created_at)
    recent = store.recent_jobs(50)
    audio: dict[str, str] = {}
    for job in recent:
        if job.recording_id not in audio:
            path = _audio_file(config, job.recording_id)
            audio[job.recording_id] = _human_size(path.stat().st_size) if path else ""
    return _templates(
        request,
        "dashboard.html",
        health=_health(config, store),
        running=_running(store),
        queue=queue,
        recent=recent,
        audio=audio,
        local=is_local_direct(request),
        tokens=store.tokens(),
        usb=request.app.state.usb.status(),
        now=utcnow_iso(),
    )


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


@router.post("/admin/recordings/{recording_id}/play", response_model=None)
def recording_play(
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
    os.startfile(path)  # type: ignore[attr-defined]  # Windows: the default media player
    return RedirectResponse(url="/admin#recent", status_code=303)


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
    # explorer.exe returns 1 even on success; Popen and forget.
    subprocess.Popen(["explorer.exe", f"/select,{path}"])  # noqa: S603, S607
    return RedirectResponse(url="/admin#recent", status_code=303)


@router.post("/admin/usb/toggle")
def usb_toggle(request: Request, _admin: Annotated[str, Depends(require_admin)]) -> RedirectResponse:
    old: Config = request.app.state.config
    apply_config(request.app, with_updates(old, usb_enabled=not old.usb_enabled))
    request.app.state.usb.poll_now()
    return RedirectResponse(url="/admin", status_code=303)


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
    return _templates(
        request,
        "devices.html",
        usb=usb,
        adopted=adopted,
        unknown=unknown,
        actions=USB_ACTIONS[1:],
        error=error,
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
    return RedirectResponse(url="/admin", status_code=303)


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
