"""Notification-area (systray) icon for the running server: status at a glance, the admin pages,
the USB and email switches, the data folders, job-finished notifications, and Quit.

Windows only; started by `__main__` (never by tests or an embedded app). The status and
notification logic are plain functions so they can be tested without a desktop.
"""

from __future__ import annotations

import logging
import os
import threading
import webbrowser
from pathlib import Path
from typing import Any, Callable, Iterable

log = logging.getLogger("r1cord_server.tray")

ICON_PATH = Path(__file__).resolve().parent / "static" / "r1cord-tray.png"
POLL_S = 3.0
# Windows limits (NOTIFYICONDATAW), each including the terminating NUL: tooltip 128, balloon
# text 256. Longer strings make Shell_NotifyIcon raise. Balloon titles here are short constants.
TOOLTIP_MAX = 127
NOTIFY_MESSAGE_MAX = 255
PROCESSING = frozenset({"transcribing", "transcribed", "writing", "written", "publishing", "published"})


def device_line(connected: Iterable[tuple[str, str, bool]], usb_enabled: bool) -> str:
    """One line for the device state, from UsbWatcher.status().connected."""
    if not usb_enabled:
        return "USB mode off"
    adopted = [model or serial for serial, model, is_adopted in connected if is_adopted]
    others = [serial for serial, _model, is_adopted in connected if not is_adopted]
    if adopted:
        return f"{adopted[0].replace('_', ' ')} connected" + (f" (+{len(adopted) - 1})" if len(adopted) > 1 else "")
    if others:
        return "Device connected, not adopted"
    return "No device connected"


def work_line(jobs: Iterable[Any]) -> str:
    """One line for the job queue, from JobStore.recent_jobs()."""
    running = None
    queued = 0
    for job in jobs:
        if job.status == "queued":
            queued += 1
        elif job.status in PROCESSING and running is None:
            running = job
    if running is not None:
        text = f"{running.status.capitalize()}: {running.title or running.recording_id}"
        return text + (f" (+{queued} queued)" if queued else "")
    if queued:
        return f"{queued} queued"
    return "Idle"


def tooltip(device: str, work: str) -> str:
    text = f"R1CORD Server · {device} · {work}"
    return _clip(text, TOOLTIP_MAX)


def finished_since(seen: dict[str, str], jobs: Iterable[Any]) -> list[tuple[str, str]]:
    """Notifications for jobs that reached `complete` or `error` since the previous poll.

    `seen` maps job_id -> last status and is updated in place. A job seen for the first time in a
    final state is not announced: at startup every old job is final, and none of them just finished.
    """
    notes: list[tuple[str, str]] = []
    for job in jobs:
        before = seen.get(job.job_id)
        seen[job.job_id] = job.status
        if before is None or before == job.status:
            continue
        name = job.title or job.recording_id
        if job.status == "complete":
            what = "Summary ready" if job.summarize else "Transcript ready"
            notes.append((what, _clip(name, NOTIFY_MESSAGE_MAX)))
        elif job.status == "error":
            # Job errors can carry a whole command line and CLI output; the first line says what failed.
            reason = (job.error or "see the job log").strip().splitlines()[0]
            notes.append(("Job failed", _clip(f"{name}: {reason}", NOTIFY_MESSAGE_MAX)))
    return notes


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Tray:
    def __init__(self, app: Any, base_url: str, request_exit: Callable[[], None]) -> None:
        self.app = app
        self.base_url = base_url.rstrip("/")
        self._request_exit = request_exit
        self._icon: Any = None
        self._stop = threading.Event()
        self._seen: dict[str, str] = {}

    # --- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._run, name="tray", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:  # the icon thread may already be gone
                log.debug("tray: stop after exit", exc_info=True)

    def _run(self) -> None:
        try:
            import pystray
            from PIL import Image
        except ImportError as exc:
            log.warning("tray: disabled, missing dependency: %s", exc)
            return
        item = pystray.MenuItem
        sep = pystray.Menu.SEPARATOR
        menu = pystray.Menu(
            item(lambda _i: "R1CORD Server", None, enabled=False),
            item(lambda _i: self._device(), None, enabled=False),
            item(lambda _i: self._work(), None, enabled=False),
            sep,
            item("Open dashboard", self._open("/admin"), default=True),
            item("Devices", self._open("/admin/devices")),
            item("Config", self._open("/admin/config")),
            sep,
            item("USB mode", self._toggle("usb_enabled"), checked=lambda _i: self._config().usb_enabled),
            item(
                "Email finished jobs",
                self._toggle("email_enabled"),
                checked=lambda _i: self._config().email_enabled,
                enabled=lambda _i: bool(self._config().email_to.strip()),
            ),
            sep,
            item("Open recordings folder", self._folder("inbox")),
            item("Open logs folder", self._folder("logs")),
            sep,
            item("Quit R1CORD Server", self._quit),
        )
        self._icon = pystray.Icon("r1cord-server", Image.open(ICON_PATH), "R1CORD Server", menu)
        log.info("tray: icon shown")
        try:
            self._icon.run(setup=self._setup)
        except Exception:
            log.exception("tray: icon loop failed")

    def _setup(self, icon: Any) -> None:
        icon.visible = True
        self._refresh(notify=False)
        threading.Thread(target=self._poll, name="tray-poll", daemon=True).start()

    def _poll(self) -> None:
        while not self._stop.wait(POLL_S):
            try:
                self._refresh(notify=True)
            except Exception:
                log.exception("tray: status refresh failed")

    def _refresh(self, *, notify: bool) -> None:
        jobs = self.app.state.store.recent_jobs(50)
        notes = finished_since(self._seen, jobs)
        icon = self._icon
        if icon is None:
            return
        icon.title = tooltip(self._device(), work_line(jobs))
        icon.update_menu()
        if notify:
            for title, message in notes:
                try:
                    icon.notify(message, title)
                except Exception:  # one bad notification must not stop the others or the poll
                    log.warning("tray: notification failed for %r", title, exc_info=True)

    # --- state -------------------------------------------------------------

    def _config(self) -> Any:
        return self.app.state.config

    def _device(self) -> str:
        status = self.app.state.usb.status()
        return device_line(status.connected, status.enabled)

    def _work(self) -> str:
        return work_line(self.app.state.store.recent_jobs(50))

    # --- actions -----------------------------------------------------------

    def _open(self, path: str) -> Callable[..., None]:
        def action(_icon: Any = None, _item: Any = None) -> None:
            webbrowser.open(self.base_url + path)

        return action

    def _toggle(self, field: str) -> Callable[..., None]:
        def action(_icon: Any = None, _item: Any = None) -> None:
            from .admin import apply_config
            from .config import with_updates

            old = self._config()
            new = with_updates(old, **{field: not getattr(old, field)})
            apply_config(self.app, new)
            log.info("tray: %s -> %s", field, getattr(new, field))
            if field == "usb_enabled":
                self.app.state.usb.poll_now()
            if self._icon is not None:
                self._icon.update_menu()

        return action

    def _folder(self, name: str) -> Callable[..., None]:
        def action(_icon: Any = None, _item: Any = None) -> None:
            folder = Path(self._config().datastore) / name
            folder.mkdir(parents=True, exist_ok=True)
            os.startfile(folder)  # type: ignore[attr-defined]  # Windows Explorer

        return action

    def _quit(self, _icon: Any = None, _item: Any = None) -> None:
        log.info("tray: quit requested")
        self.stop()
        self._request_exit()
