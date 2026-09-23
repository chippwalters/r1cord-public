"""USB mode: poll adb for adopted devices and pull finished recordings into inbox/.

The watcher is the only thread besides the worker. It runs adb and JobStore calls
only; it never executes a pipeline step. Every adb invocation has a timeout.
"""

from __future__ import annotations

import json
import logging
import os
import re
import queue
import shutil
import subprocess
import threading
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config
from .store import AUDIO_NAMES, FILE_NAME_RE, JobStore, sha256_file

log = logging.getLogger("r1cord_server.usb")

RECORDING_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
FINAL_STATUSES = frozenset({"SAVED", "INTERRUPTED"})
DEVICES_TIMEOUT_S = 10
LIST_TIMEOUT_S = 30
PULL_TIMEOUT_S = 600
# The R1 client falls back to http://127.0.0.1:8765 when it has no validated network;
# the watcher reverse-forwards that device port to this server for adopted devices.
DEVICE_LOOPBACK_PORT = 8765
# adb.exe is a console app; spawned from a console-less pythonw process Windows would
# otherwise open a new console window for every poll.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class AdbError(Exception):
    """adb exited non-zero or timed out; the device is probably gone."""


@dataclass(frozen=True)
class UsbDevice:
    serial: str
    state: str
    model: str


@dataclass
class UsbStatus:
    enabled: bool
    adb: str
    connected: list[tuple[str, str, bool]] = field(default_factory=list)
    syncing: str | None = None
    last_error: str | None = None


def parse_devices(text: str) -> list[UsbDevice]:
    """Parse `adb devices -l` output."""
    devices: list[UsbDevice] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("List of devices") or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        model = ""
        for token in parts[2:]:
            if token.startswith("model:"):
                model = token[len("model:"):]
        devices.append(UsbDevice(serial=parts[0], state=parts[1], model=model))
    return devices


def parse_listing(text: str) -> dict[str, dict[str, tuple[int, int]]]:
    """Parse `find . -type f -exec stat -c '%s %Y %n' {} +` output run inside the device root.

    Returns {recordingId: {fileName: (size, mtime)}}. Files not exactly one folder deep
    are ignored; so are names that would not be safe on disk.
    """
    listing: dict[str, dict[str, tuple[int, int]]] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(" ", 2)
        if len(parts) != 3:
            continue
        try:
            size = int(parts[0])
            mtime = int(parts[1])
        except ValueError:
            continue
        rel = parts[2]
        if rel.startswith("./"):
            rel = rel[2:]
        segments = rel.split("/")
        if len(segments) != 2:
            continue
        recording_id, name = segments
        if not RECORDING_ID_RE.fullmatch(recording_id) or not FILE_NAME_RE.fullmatch(name):
            continue
        listing.setdefault(recording_id, {})[name] = (size, mtime)
    return listing


def parse_track_frames(buf: bytes) -> tuple[list[str], bytes]:
    """Split `adb track-devices -l` output into complete frames.

    The adb server sends `%04x`-length-prefixed device lists; the Windows client rewrites
    `\\n` as `\\r\\n`, so normalize first — the declared length counts the original bytes.
    Returns (frame texts, unconsumed remainder).
    """
    buf = buf.replace(b"\r\n", b"\n")
    frames: list[str] = []
    while len(buf) >= 4:
        try:
            n = int(buf[:4], 16)
        except ValueError:
            raise AdbError(f"track-devices: bad frame prefix {buf[:4]!r}") from None
        if len(buf) < 4 + n:
            break
        frames.append(buf[4 : 4 + n].decode("utf-8", errors="replace"))
        buf = buf[4 + n :]
    return frames, buf


class _Event:
    """Watcher loop events. `devices` is None for wake-ups that carry no device list."""

    __slots__ = ("devices",)

    def __init__(self, devices: list[UsbDevice] | None = None) -> None:
        self.devices = devices


_STOP = _Event()
_WAKE = _Event()
_TRACKER_DIED = _Event()
TRACKER_RETRY_S = 5
IDLE_CHECK_S = 30


class UsbWatcher:
    def __init__(
        self,
        store: JobStore,
        config_ref: Callable[[], Config],
        *,
        request_exit: Callable[[], None] | None = None,
        last_activity: Callable[[], float | None] | None = None,
    ) -> None:
        self.store = store
        self._config = config_ref
        self._request_exit = request_exit
        self._last_activity = last_activity or (lambda: None)
        self._stop = threading.Event()
        self._events: queue.Queue[_Event] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._tracker: subprocess.Popen[bytes] | None = None
        self._state_lock = threading.Lock()
        self._devices: list[UsbDevice] = []
        self._connected: list[tuple[str, str, bool]] = []
        self._syncing: str | None = None
        self._last_error: str | None = None
        self._reversed: set[str] = set()
        self._last_adopted_seen = time.monotonic()

    # --- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._last_adopted_seen = time.monotonic()
        self._thread = threading.Thread(target=self._loop, name="usb-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._events.put(_STOP)
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        self._stop_tracker()

    def poll_now(self) -> None:
        self._events.put(_WAKE)

    def status(self) -> UsbStatus:
        cfg = self._config()
        adb = self.adb_path(cfg)
        with self._state_lock:
            return UsbStatus(
                enabled=cfg.usb_enabled,
                adb=adb or "not found",
                connected=list(self._connected),
                syncing=self._syncing,
                last_error=self._last_error,
            )

    @staticmethod
    def adb_path(cfg: Config) -> str | None:
        path = Path(cfg.adb_cmd)
        if path.is_file():
            return str(path)
        found = shutil.which(cfg.adb_cmd)
        if found:
            return found
        candidates = [Path(__file__).resolve().parent.parent / "tools" / "platform-tools" / "adb.exe"]
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates.append(Path(local) / "Android" / "Sdk" / "platform-tools" / "adb.exe")
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
        return None

    # --- loop --------------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            cfg = self._config()
            adb = self.adb_path(cfg) if cfg.usb_enabled else None
            if adb is None:
                self._stop_tracker()
                with self._state_lock:
                    self._connected = []
                    self._syncing = None
                if cfg.usb_enabled:
                    self._set_error(f"adb not found: {cfg.adb_cmd}")
                self._idle_check(cfg)
                self._await(TRACKER_RETRY_S)
                continue
            if self._tracker is None or self._tracker.poll() is not None:
                try:
                    self._start_tracker(adb)
                    self.poll_once(cfg)  # initial state; frames take over from here
                except Exception as exc:
                    log.warning("usb: tracker start failed: %s", exc)
                    self._set_error(f"adb: {exc}")
                    self._await(TRACKER_RETRY_S)
                    continue
            adopted_connected = any(adopted for _, _, adopted in self._connected)
            timeout: float | None = cfg.usb_poll_s if adopted_connected else (
                IDLE_CHECK_S if cfg.run_mode == "plug" else None
            )
            event = self._await(timeout)
            if event is _STOP or self._stop.is_set():
                break
            try:
                if event is _TRACKER_DIED:
                    continue  # loop restarts it
                if event is not None and event.devices is not None:
                    self._devices = event.devices
                self._apply(adb, cfg, self._devices)
                self._idle_check(cfg)
            except Exception as exc:
                log.exception("usb: sync failed")
                self._set_error(f"sync: {exc}")

    def _await(self, timeout: float | None) -> _Event | None:
        try:
            return self._events.get(timeout=timeout)
        except queue.Empty:
            return None

    def _start_tracker(self, adb: str) -> None:
        self._tracker = subprocess.Popen(  # noqa: S603 — argv list, shell=False
            [adb, "track-devices", "-l"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=tempfile.gettempdir(),  # a tracker orphaned by a hard kill must not pin the install folder
            creationflags=_NO_WINDOW,
        )
        proc = self._tracker
        threading.Thread(target=self._read_tracker, args=(proc,), name="usb-tracker", daemon=True).start()
        log.info("usb: tracking devices via adb (pid %d)", proc.pid)

    def _read_tracker(self, proc: subprocess.Popen[bytes]) -> None:
        buf = b""
        assert proc.stdout is not None
        try:
            while True:
                chunk = proc.stdout.read1(4096)  # type: ignore[attr-defined]
                if not chunk:
                    break
                buf += chunk
                frames, buf = parse_track_frames(buf)
                for frame in frames:
                    self._events.put(_Event([d for d in parse_devices(frame) if d.state == "device"]))
        except Exception as exc:
            log.warning("usb: tracker read failed: %s", exc)
        if proc is self._tracker and not self._stop.is_set():
            self._events.put(_TRACKER_DIED)

    def _stop_tracker(self) -> None:
        proc, self._tracker = self._tracker, None
        if proc is not None and proc.poll() is None:
            proc.kill()

    def poll_once(self, cfg: Config | None = None) -> None:
        """One synchronous `adb devices -l` + sync pass. Initial state, Sync now, and tests."""
        cfg = cfg or self._config()
        adb = self.adb_path(cfg)
        if adb is None:
            self._set_error(f"adb not found: {cfg.adb_cmd}")
            with self._state_lock:
                self._connected = []
            return
        out = self._run([adb, "devices", "-l"], timeout=DEVICES_TIMEOUT_S)
        self._devices = [d for d in parse_devices(out) if d.state == "device"]
        self._apply(adb, cfg, self._devices)

    def _apply(self, adb: str, cfg: Config, devices: list[UsbDevice]) -> None:
        adopted = self.store.adopted_serials()
        for dev in devices:
            self.store.upsert_device_seen(dev.serial, dev.model)
        with self._state_lock:
            self._connected = [(d.serial, d.model, d.serial in adopted) for d in devices]
        failed = False
        for dev in devices:
            if dev.serial not in adopted:
                continue
            if self._stop.is_set():
                return
            self._last_adopted_seen = time.monotonic()
            try:
                self._ensure_reverse(adb, dev.serial, cfg)
                self.sync_device(adb, dev.serial, cfg)
                self.store.device_synced(dev.serial, None)
            except AdbError as exc:
                failed = True
                self._reversed.discard(dev.serial)
                log.warning("usb: %s sync aborted: %s", dev.serial, exc)
                self.store.device_synced(dev.serial, str(exc))
                self._set_error(f"{dev.serial}: {exc}")
            finally:
                with self._state_lock:
                    self._syncing = None
        present = {d.serial for d in devices if d.serial in adopted}
        self._reversed &= present
        if not failed:
            self._set_error(None)

    def _idle_check(self, cfg: Config, now: float | None = None) -> bool:
        """In `plug` mode, ask the server to exit once nothing has needed it for `idle_exit_min`."""
        if cfg.run_mode != "plug" or self._request_exit is None:
            return False
        now = time.monotonic() if now is None else now
        if any(adopted for _, _, adopted in self._connected):
            self._last_adopted_seen = now
            return False
        last = max(self._last_adopted_seen, self._last_activity() or 0.0)
        if now - last < cfg.idle_exit_min * 60:
            return False
        if self.store.has_active_jobs():
            return False
        log.info("usb: idle for %d min with no adopted device; exiting (run_mode=plug)", cfg.idle_exit_min)
        self._request_exit()
        return True

    def _ensure_reverse(self, adb: str, serial: str, cfg: Config) -> None:
        """Forward the device's loopback port to this server so the R1 can Send/Refresh over the cable."""
        if serial in self._reversed:
            return
        self._run(
            [adb, "-s", serial, "reverse", f"tcp:{DEVICE_LOOPBACK_PORT}", f"tcp:{cfg.listen_port}"],
            timeout=DEVICES_TIMEOUT_S,
        )
        self._reversed.add(serial)
        log.info("usb: %s reverse tcp:%d -> %d", serial, DEVICE_LOOPBACK_PORT, cfg.listen_port)

    # --- sync --------------------------------------------------------------

    def sync_device(self, adb: str, serial: str, cfg: Config) -> None:
        listing = self._list(adb, serial, cfg)
        for recording_id in sorted(listing):
            if self._stop.is_set():
                return
            self._sync_recording(adb, serial, recording_id, listing[recording_id], cfg)

    def _list(self, adb: str, serial: str, cfg: Config) -> dict[str, dict[str, tuple[int, int]]]:
        root = cfg.usb_device_root.rstrip("/")
        cmd = (
            f"if cd {root} 2>/dev/null; then "
            "find . -type f -exec stat -c '%s %Y %n' {} +; fi"
        )
        out = self._run([adb, "-s", serial, "shell", cmd], timeout=LIST_TIMEOUT_S)
        return parse_listing(out)

    def _sync_recording(
        self,
        adb: str,
        serial: str,
        recording_id: str,
        files: dict[str, tuple[int, int]],
        cfg: Config,
    ) -> None:
        store = self.store
        meta_listed = files.get("metadata.json")
        if meta_listed is None:
            log.info("usb: %s skipped %s (no metadata.json)", serial, recording_id)
            return
        inbox = store.inbox_dir(recording_id)
        known = store.device_file_state(serial, recording_id)
        remote_dir = f"{cfg.usb_device_root.rstrip('/')}/{recording_id}"

        if known.get("metadata.json") != meta_listed or not (inbox / "metadata.json").is_file():
            self._pull_file(adb, serial, remote_dir, inbox, "metadata.json", meta_listed)
            store.record_pulled_file(
                serial, recording_id, "metadata.json", meta_listed[0], meta_listed[1],
                sha256_file(inbox / "metadata.json"),
            )
        try:
            metadata = json.loads((inbox / "metadata.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("usb: %s %s metadata.json unreadable: %s", serial, recording_id, exc)
            store.mark_device_recording(
                serial, recording_id, device_status="UNKNOWN", title="", created_at_ms=0
            )
            store.flag_device_recording(serial, recording_id, "pull_failed")
            return
        if not isinstance(metadata, dict):
            metadata = {}
        status = str(metadata.get("status") or "UNKNOWN")
        title = str(metadata.get("title") or "")
        try:
            created_at_ms = int(metadata.get("createdAt") or 0)
        except (TypeError, ValueError):
            created_at_ms = 0
        store.mark_device_recording(
            serial, recording_id, device_status=status, title=title, created_at_ms=created_at_ms
        )

        if status not in FINAL_STATUSES:
            log.info("usb: %s skipped %s (status %s)", serial, recording_id, status)
            return
        if store.active_job_for(recording_id) is not None:
            log.info("usb: %s skipped %s (job active)", serial, recording_id)
            return

        had_job = store.latest_for(recording_id) is not None
        changed = False
        mismatch = False
        for name in sorted(files):
            if name == "metadata.json":
                continue
            size, mtime = files[name]
            target = inbox / name
            if known.get(name) == (size, mtime) and target.is_file():
                continue
            if target.is_file() and target.stat().st_size == size and name not in known:
                # Already delivered over Wi-Fi (audio and photo names are immutable ids).
                store.record_pulled_file(
                    serial, recording_id, name, size, mtime, sha256_file(target)
                )
                log.info("usb: %s %s/%s already in inbox, not transferred", serial, recording_id, name)
                continue
            with self._state_lock:
                self._syncing = f"{recording_id}/{name}"
            partial = self._pull_partial(adb, serial, remote_dir, inbox, name, size)
            digest = sha256_file(partial)
            if name in AUDIO_NAMES and target.is_file() and sha256_file(target) != digest:
                partial.unlink()
                mismatch = True
                store.record_pulled_file(serial, recording_id, name, size, mtime, digest)
                log.warning("usb: %s %s/%s differs from inbox audio; kept inbox copy",
                            serial, recording_id, name)
                continue
            os.replace(partial, target)
            store.record_pulled_file(serial, recording_id, name, size, mtime, digest)
            changed = True
            log.info("usb: %s pulled %s/%s %d bytes", serial, recording_id, name, size)

        store.device_recording_pulled(serial, recording_id)
        store.flag_device_recording(serial, recording_id, "audio_mismatch" if mismatch else None)
        if had_job:
            if changed:
                store.flag_changed_since_job(serial, recording_id)
            return
        if status != "SAVED" or cfg.usb_auto_action == "archive":
            return
        if not any((inbox / n).is_file() for n in AUDIO_NAMES):
            return
        try:
            rec = store.process_inbox(recording_id, action=cfg.usb_auto_action)
        except Exception as exc:
            log.warning("usb: %s could not queue %s: %s", serial, recording_id, exc)
            store.flag_device_recording(serial, recording_id, "process_failed")
            return
        store.set_auto_job(serial, recording_id, rec.job_id)
        log.info("usb: %s queued %s as %s (%s)", serial, recording_id, rec.job_id, cfg.usb_auto_action)

    def _pull_file(
        self,
        adb: str,
        serial: str,
        remote_dir: str,
        inbox: Path,
        name: str,
        listed: tuple[int, int],
    ) -> None:
        partial = self._pull_partial(adb, serial, remote_dir, inbox, name, listed[0])
        os.replace(partial, inbox / name)

    def _pull_partial(
        self,
        adb: str,
        serial: str,
        remote_dir: str,
        inbox: Path,
        name: str,
        expected_size: int,
    ) -> Path:
        upload = inbox / ".upload"
        upload.mkdir(parents=True, exist_ok=True)
        partial = upload / f"{name}.partial"
        if partial.exists():
            partial.unlink()
        try:
            self._run(
                [adb, "-s", serial, "pull", "-a", f"{remote_dir}/{name}", str(partial)],
                timeout=PULL_TIMEOUT_S,
            )
            actual = partial.stat().st_size if partial.is_file() else -1
            if actual != expected_size:
                raise AdbError(f"pull {name}: got {actual} bytes, device lists {expected_size}")
        except Exception:
            if partial.exists():
                partial.unlink()
            raise
        return partial

    # --- helpers -----------------------------------------------------------

    def _run(self, args: list[str], *, timeout: int) -> str:
        try:
            proc = subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=timeout,
                check=False,
                creationflags=_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AdbError(f"{' '.join(args[:3])}: {exc}") from exc
        stdout = proc.stdout.decode("utf-8", errors="replace")
        stderr = proc.stderr.decode("utf-8", errors="replace").strip()
        if proc.returncode != 0:
            raise AdbError(f"{' '.join(args[:3])} exited {proc.returncode}: {stderr or stdout.strip()}")
        return stdout

    def _set_error(self, message: str | None) -> None:
        with self._state_lock:
            self._last_error = message
