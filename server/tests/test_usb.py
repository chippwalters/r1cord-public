from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

import pytest

from r1cord_server.config import Config
from r1cord_server.store import JobStore
from r1cord_server.usb import AdbError, UsbWatcher, parse_devices, parse_listing, parse_track_frames

SERIAL = "R1DEVICESERIAL001"
ROOT = "/sdcard/Download/R1CORD"


class FakeAdb:
    """Serves `adb devices -l`, the listing shell command and `adb pull` from a folder tree."""

    def __init__(self, tree: Path) -> None:
        self.tree = tree
        self.devices: list[tuple[str, str]] = [(SERIAL, "device")]
        self.pulled: list[str] = []
        self.reversed: list[str] = []
        self.truncate: set[str] = set()

    def run(self, args: list[str], *, timeout: int) -> str:
        if args[1:] == ["devices", "-l"]:
            lines = ["List of devices attached"]
            for serial, state in self.devices:
                lines.append(f"{serial}          {state} product:gsi_r1 model:R1 device:r1 transport_id:3")
            return "\n".join(lines) + "\n"
        assert args[1] == "-s"
        serial = args[2]
        if serial not in {s for s, _ in self.devices}:
            raise AdbError(f"device '{serial}' not found")
        if args[3] == "shell":
            assert ROOT in args[4] and "stat -c" in args[4]
            root = self.tree / serial
            if not root.is_dir():
                return ""
            out = []
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    rel = path.relative_to(root).as_posix()
                    st = path.stat()
                    out.append(f"{st.st_size} {int(st.st_mtime)} ./{rel}")
            return "\n".join(out) + "\n"
        if args[3] == "reverse":
            self.reversed.append(f"{serial} {args[4]} {args[5]}")
            return ""
        if args[3] == "pull":
            remote, local = args[5], args[6]
            rel = remote[len(ROOT) + 1 :]
            src = self.tree / serial / rel
            if not src.is_file():
                raise AdbError(f"remote object '{remote}' does not exist")
            self.pulled.append(rel)
            data = src.read_bytes()
            if rel in self.truncate:
                data = data[: len(data) // 2]
            Path(local).write_bytes(data)
            return f"{remote}: 1 file pulled\n"
        raise AssertionError(f"unexpected adb call {args}")


def _cfg(tmp_path: Path, **overrides: object) -> Config:
    return Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://example.test/files",
        admin_password="test-admin-pass1",
        adb_cmd=str(tmp_path / "adb.exe"),
        **overrides,  # type: ignore[arg-type]
    )


def _device_recording(
    tree: Path,
    recording_id: str,
    *,
    status: str = "SAVED",
    title: str = "Site visit",
    audio: bytes = b"m4a-bytes",
    photos: dict[str, bytes] | None = None,
) -> Path:
    folder = tree / SERIAL / recording_id
    folder.mkdir(parents=True, exist_ok=True)
    audio_name = "audio.m4a" if status == "SAVED" else "audio.partial.m4a"
    (folder / audio_name).write_bytes(audio)
    for name, data in (photos or {}).items():
        (folder / name).write_bytes(data)
    (folder / "metadata.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": recording_id,
                "title": title,
                "createdAt": 1_758_400_000_000,
                "status": status,
                "audio": audio_name,
                "photos": [{"id": n[6:-4], "file": n, "status": "SAVED"} for n in (photos or {})],
            }
        ),
        encoding="utf-8",
    )
    return folder


@pytest.fixture
def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    tree = tmp_path / "device"
    fake = FakeAdb(tree)
    (tmp_path / "adb.exe").write_bytes(b"")
    holder: dict[str, Config] = {"cfg": _cfg(tmp_path)}
    store = JobStore(holder["cfg"])
    store.adopt_device(SERIAL)
    watcher = UsbWatcher(store, lambda: holder["cfg"])
    monkeypatch.setattr(watcher, "_run", fake.run)
    return tree, fake, store, watcher, holder


def test_parse_devices_states_and_model() -> None:
    text = (
        "List of devices attached\n"
        "R1DEVICESERIAL001   device product:gsi_r1 model:R1 device:r1 transport_id:3\n"
        "emulator-5572          offline transport_id:31540\n"
        "ABCD                   unauthorized usb:1-2\n"
    )
    devices = parse_devices(text)
    assert [(d.serial, d.state, d.model) for d in devices] == [
        ("R1DEVICESERIAL001", "device", "R1"),
        ("emulator-5572", "offline", ""),
        ("ABCD", "unauthorized", ""),
    ]


def test_parse_listing_only_one_level_deep_and_safe_names() -> None:
    text = (
        "65123456 1758400100 ./20260920-2000-ab12/audio.m4a\n"
        "812345 1758400200 ./20260920-2000-ab12/photo-abc.jpg\n"
        "1500 1758400300 ./20260920-2000-ab12/metadata.json\n"
        "12 1758400400 ./stray.txt\n"
        "12 1758400400 ./deep/er/file.bin\n"
        "12 1758400400 ./bad id/audio.m4a\n"
        "garbage line\n"
    )
    listing = parse_listing(text)
    assert set(listing) == {"20260920-2000-ab12"}
    assert listing["20260920-2000-ab12"]["audio.m4a"] == (65123456, 1758400100)
    assert len(listing["20260920-2000-ab12"]) == 3


def test_first_sync_pulls_everything_and_queues_configured_action(setup) -> None:
    tree, fake, store, watcher, holder = setup
    holder["cfg"] = replace(holder["cfg"], usb_auto_action="summarize")
    _device_recording(tree, "rec-1", photos={"photo-p1.jpg": b"jpeg"})

    watcher.poll_once()

    inbox = store.inbox_dir("rec-1")
    assert (inbox / "audio.m4a").read_bytes() == b"m4a-bytes"
    assert (inbox / "photo-p1.jpg").read_bytes() == b"jpeg"
    assert not (inbox / ".upload" / "audio.m4a.partial").exists()
    job = store.latest_for("rec-1")
    assert job is not None and job.status == "queued"
    assert job.summarize is True and job.publish is False
    assert job.title == "Site visit"
    rows = store.device_recordings(SERIAL)
    assert rows[0].auto_job_id == job.job_id and rows[0].pulled_at

    # Nothing changed: second pass transfers nothing and creates no job.
    before = list(fake.pulled)
    watcher.poll_once()
    assert fake.pulled == before
    assert store.latest_for("rec-1").job_id == job.job_id
    # Loopback route for the R1 client: set up once, not on every poll.
    assert fake.reversed == [f"{SERIAL} tcp:8765 tcp:8765"]


def test_archive_action_pulls_without_job(setup) -> None:
    tree, fake, store, watcher, holder = setup
    holder["cfg"] = replace(holder["cfg"], usb_auto_action="archive")
    _device_recording(tree, "rec-a")

    watcher.poll_once()

    assert (store.inbox_dir("rec-a") / "audio.m4a").is_file()
    assert store.latest_for("rec-a") is None
    rec = store.process_inbox("rec-a", action="transcribe")
    assert rec.summarize is False and rec.publish is False and rec.status == "queued"


def test_new_photo_after_job_is_pulled_and_flagged(setup) -> None:
    tree, fake, store, watcher, holder = setup
    folder = _device_recording(tree, "rec-2")
    watcher.poll_once()
    first_job = store.latest_for("rec-2")
    store.set_status(first_job.job_id, "complete")

    (folder / "photo-p9.jpg").write_bytes(b"late-jpeg")
    meta = json.loads((folder / "metadata.json").read_text())
    meta["photos"] = [{"id": "p9", "file": "photo-p9.jpg", "status": "SAVED"}]
    (folder / "metadata.json").write_text(json.dumps(meta, indent=2))
    fake.pulled.clear()

    watcher.poll_once()

    assert sorted(fake.pulled) == ["rec-2/metadata.json", "rec-2/photo-p9.jpg"]
    assert (store.inbox_dir("rec-2") / "photo-p9.jpg").is_file()
    assert store.latest_for("rec-2").job_id == first_job.job_id
    row = store.device_recordings(SERIAL)[0]
    assert row.changed_since_job is True


def test_recording_in_progress_is_skipped_until_saved(setup) -> None:
    tree, fake, store, watcher, holder = setup
    folder = _device_recording(tree, "rec-3", status="RECORDING")

    watcher.poll_once()
    assert fake.pulled == ["rec-3/metadata.json"]
    assert not (store.inbox_dir("rec-3") / "audio.partial.m4a").exists()
    assert store.latest_for("rec-3") is None
    assert store.device_recordings(SERIAL)[0].device_status == "RECORDING"

    shutil.rmtree(folder)
    _device_recording(tree, "rec-3", status="SAVED")
    watcher.poll_once()
    assert (store.inbox_dir("rec-3") / "audio.m4a").is_file()
    assert store.latest_for("rec-3").status == "queued"


def test_short_pull_promotes_nothing_and_records_device_error(setup) -> None:
    tree, fake, store, watcher, holder = setup
    _device_recording(tree, "rec-4", audio=b"0123456789")
    fake.truncate.add("rec-4/audio.m4a")

    watcher.poll_once()

    inbox = store.inbox_dir("rec-4")
    assert not (inbox / "audio.m4a").exists()
    assert not (inbox / ".upload" / "audio.m4a.partial").exists()
    assert store.latest_for("rec-4") is None
    device = next(d for d in store.devices() if d.serial == SERIAL)
    assert device.last_error and "audio.m4a" in device.last_error
    assert watcher.status().last_error

    fake.truncate.clear()
    watcher.poll_once()
    assert (inbox / "audio.m4a").read_bytes() == b"0123456789"
    assert watcher.status().last_error is None


def test_audio_mismatch_keeps_inbox_copy(setup) -> None:
    tree, fake, store, watcher, holder = setup
    inbox = store.inbox_dir("rec-5")
    (inbox / "audio.m4a").write_bytes(b"wifi-copy")
    _device_recording(tree, "rec-5", audio=b"different-bytes")

    watcher.poll_once()

    assert (inbox / "audio.m4a").read_bytes() == b"wifi-copy"
    row = store.device_recordings(SERIAL)[0]
    assert row.flag == "audio_mismatch"
    # The inbox copy is authoritative and still a valid recording: it gets the auto job.
    assert store.latest_for("rec-5").status == "queued"


def test_unadopted_device_is_seen_but_not_pulled(setup) -> None:
    tree, fake, store, watcher, holder = setup
    fake.devices = [("OTHER-PHONE", "device")]
    (tree / "OTHER-PHONE" / "rec-9").mkdir(parents=True)
    (tree / "OTHER-PHONE" / "rec-9" / "audio.m4a").write_bytes(b"x")

    watcher.poll_once()

    assert fake.pulled == []
    seen = {d.serial: d for d in store.devices()}
    assert "OTHER-PHONE" in seen and not seen["OTHER-PHONE"].adopted
    assert watcher.status().connected == [("OTHER-PHONE", "R1", False)]


def test_recordings_index_hides_url_for_transcribe_only_jobs(setup) -> None:
    tree, fake, store, watcher, holder = setup
    holder["cfg"] = replace(holder["cfg"], usb_auto_action="transcribe")
    _device_recording(tree, "rec-6")
    watcher.poll_once()

    entry = next(e for e in store.recordings_index() if e.recording_id == "rec-6")
    assert entry.webdav_url is None
    job = store.latest_for("rec-6")
    assert store.result_json(job.job_id)["webdavUrl"] is None


def test_wifi_delivered_file_is_adopted_without_transfer(setup) -> None:
    tree, fake, store, watcher, holder = setup
    inbox = store.inbox_dir("rec-7")
    (inbox / "audio.m4a").write_bytes(b"m4a-bytes")
    _device_recording(tree, "rec-7", audio=b"m4a-bytes")

    watcher.poll_once()

    assert "rec-7/audio.m4a" not in fake.pulled
    state = store.device_file_state(SERIAL, "rec-7")
    assert state["audio.m4a"][0] == len(b"m4a-bytes")
    assert hashlib.sha256(b"m4a-bytes").hexdigest() == hashlib.sha256((inbox / "audio.m4a").read_bytes()).hexdigest()


def test_parse_track_frames_handles_windows_crlf_and_partial_frames() -> None:
    # Shape captured from platform-tools 37.0.1 on Windows: %04x length of the *original* bytes,
    # but the client has rewritten every \n as \r\n.
    payload = (
        "R1DEVICESERIAL001   device product:gsi_r1 model:Rabbit_R1 transport_id:3\n"
        "emulator-5572          offline transport_id:4\n"
    )
    frame = f"{len(payload):04x}{payload}".encode().replace(b"\n", b"\r\n")
    empty = b"0000"
    frames, rest = parse_track_frames(frame + empty + frame[:10])
    assert len(frames) == 2
    assert [d.serial for d in parse_devices(frames[0]) if d.state == "device"] == ["R1DEVICESERIAL001"]
    assert frames[1] == ""
    assert rest == frame[:10].replace(b"\r\n", b"\n")
    with pytest.raises(AdbError):
        parse_track_frames(b"zzzz")


def test_idle_exit_only_in_plug_mode_when_nothing_needs_the_server(setup) -> None:
    tree, fake, store, watcher, holder = setup
    exits: list[int] = []
    activity: list[float | None] = [None]
    watcher._request_exit = lambda: exits.append(1)
    watcher._last_activity = lambda: activity[0]
    start = watcher._last_adopted_seen
    plug = replace(holder["cfg"], run_mode="plug", idle_exit_min=1)

    assert watcher._idle_check(plug, now=start + 30) is False       # inside the grace window
    assert watcher._idle_check(replace(plug, run_mode="always"), now=start + 3600) is False

    activity[0] = start + 50                                          # someone used the admin UI
    assert watcher._idle_check(plug, now=start + 100) is False
    assert watcher._idle_check(plug, now=start + 111) is True         # 61 s after the last activity
    assert exits == [1]

    # An adopted device on the cable keeps it alive indefinitely.
    _device_recording(tree, "rec-idle")
    holder["cfg"] = replace(plug, usb_auto_action="archive")
    watcher.poll_once()
    assert watcher._idle_check(plug, now=start + 10_000) is False

    # Unplugged, but a job is still running: stay up.
    fake.devices = []
    watcher.poll_once()
    rec = store.process_inbox("rec-idle", action="transcribe")
    assert rec.status == "queued"
    assert watcher._idle_check(plug, now=start + 20_000) is False
    store.set_status(rec.job_id, "complete")
    assert watcher._idle_check(plug, now=start + 20_000) is True
