from __future__ import annotations

import json
import logging
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from r1cord_server import mailer, mddocs, naming
from r1cord_server.config import Config
from r1cord_server.pipeline import asr as asr_mod
from r1cord_server.pipeline import writers as writers_mod
from r1cord_server.pipeline.asr import AsrResult
from r1cord_server.store import JobStore
from r1cord_server.worker import Worker

RECORDING_ID = "rec-worker-1"


def _cfg(tmp_path: Path, **overrides: object) -> Config:
    return Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://example.test/files",
        admin_password="test-admin-pass1",
        **overrides,  # type: ignore[arg-type]
    )


class FakeAsr:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str | None]] = []
        self.fail = False

    def transcribe(self, audio: Path, out_dir: Path, *, model: str, device: str, language: str | None, log) -> AsrResult:
        self.calls.append((audio.name, model, device, language))
        if self.fail:
            raise RuntimeError("whisper exploded")
        (out_dir / "transcript.txt").write_text("hello world", encoding="utf-8")
        (out_dir / "transcript.json").write_text("{}\n", encoding="utf-8")
        return AsrResult(model=model, device=device, language=language or "en", duration_ms=1000)


class FakeWriters:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.fail = False

    def summarize(self, work_dir: Path, *, writer: str, timeout_s: int, config, log) -> Path:
        n = len(self.calls) + 1
        self.calls.append({"work": work_dir, "writer": writer, "timeout_s": timeout_s})
        if self.fail:
            raise RuntimeError("claude CLI died")
        instructions = (work_dir / "INSTRUCTIONS.md").read_text(encoding="utf-8")
        assert "Site visit" in instructions, "writer must receive INSTRUCTIONS.md with the title"
        (work_dir / "summary.md").write_text(
            f"[brand-header]\n# Site visit\n\nTake {n}\n", encoding="utf-8"
        )
        return work_dir / "summary.md"


class FakeBridge:
    """Stands in for MdDocsBridge; records actions and writes summary.html like the app."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.fail_on: str | None = None
        self.folder: Path | None = None

    def ensure_running(self) -> None:
        self.calls.append(("ensure_running", {}))

    def call(self, action: str, params: dict) -> dict:
        self.calls.append((action, dict(params)))
        if action == self.fail_on:
            raise RuntimeError(f"{action} exploded")
        if action == "open_project":
            self.folder = Path(params["folderPath"])
        if action == "publish" and self.folder is not None:
            (self.folder / "summary.html").write_text("<html></html>", encoding="utf-8")
        return {"success": True}


class Rig:
    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.cfg = _cfg(tmp_path)
        self.store = JobStore(self.cfg)
        self.worker = Worker(self.store, self.cfg)
        self.fake_asr = FakeAsr()
        self.fake_writers = FakeWriters()
        self.bridge = FakeBridge()
        monkeypatch.setattr(asr_mod, "transcribe", self.fake_asr.transcribe)
        monkeypatch.setattr(writers_mod, "summarize", self.fake_writers.summarize)
        monkeypatch.setattr(mddocs, "MdDocsBridge", lambda: self.bridge)

    def stage_recording(self, recording_id: str = RECORDING_ID, *, photos: tuple[str, ...] = ()) -> Path:
        inbox = self.store.inbox_dir(recording_id)
        (inbox / "audio.m4a").write_bytes(b"m4a-bytes")
        for name in photos:
            (inbox / name).write_bytes(b"jpeg")
        (inbox / "metadata.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": recording_id,
                    "title": "Site visit",
                    "createdAt": 1_758_400_000_000,
                    "status": "SAVED",
                }
            ),
            encoding="utf-8",
        )
        return inbox

    def queue(self, action: str, recording_id: str = RECORDING_ID, *, photos: tuple[str, ...] = ()):
        self.stage_recording(recording_id, photos=photos)
        return self.store.process_inbox(recording_id, action=action)

    def run(self, job_id: str):
        rec = self.store.job(job_id)
        assert rec is not None
        self.worker._run_job(rec)
        fresh = self.store.job(job_id)
        assert fresh is not None
        return fresh


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    return Rig(tmp_path, monkeypatch)


def _warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        rec.getMessage()
        for rec in caplog.records
        if rec.name == "r1cord_server.worker" and rec.levelno >= logging.WARNING
    ]


def test_transcribe_only_job_completes_without_writer_or_publish(rig: Rig) -> None:
    job = rig.queue("transcribe")

    rec = rig.run(job.job_id)

    assert rec.status == "complete" and rec.error is None
    outbox = rig.store.outbox_dir(RECORDING_ID)
    assert (outbox / "transcript.txt").read_text(encoding="utf-8") == "hello world"
    assert rig.fake_writers.calls == []
    assert rig.bridge.calls == []
    log_lines = "\n".join(rig.store.read_log(job.job_id))
    assert "asr: done" in log_lines and "writer: skipped" in log_lines
    assert rig.store.result_json(job.job_id)["webdavUrl"] is None


def test_summarize_without_publish_installs_summary_and_photos(rig: Rig) -> None:
    job = rig.queue("summarize", photos=("photo-p1.jpg",))

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    outbox = rig.store.outbox_dir(RECORDING_ID)
    summary = (outbox / "summary.md").read_text(encoding="utf-8")
    assert summary.startswith("[brand-header]\n")
    assert (outbox / "photos" / "photo-p1.jpg").is_file()
    assert rig.bridge.calls == []  # publish never ran
    assert rig.store.result_json(job.job_id)["webdavUrl"] is None
    assert rig.fake_writers.calls[0]["timeout_s"] == rig.cfg.writer_timeout_s


def test_publish_action_runs_bridge_and_keeps_webdav_url(rig: Rig) -> None:
    job = rig.queue("publish")

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    assert rig.store.result_json(job.job_id)["webdavUrl"] == naming.webdav_url(
        rig.cfg, Path(job.publish_folder)
    )
    assert [a for a, _ in rig.bridge.calls] == [
        "ensure_running", "open_project", "load_file", "refresh_file", "set_theme", "save_file_as", "publish",
    ]
    html = Path(job.publish_folder) / "summary.html"
    assert html.is_file() and html.read_text(encoding="utf-8") == "<html></html>"


def test_only_publish_retry_skips_asr_and_writer(rig: Rig) -> None:
    job = rig.queue("summarize")
    rig.run(job.job_id)
    assert rig.fake_asr.calls and rig.fake_writers.calls
    rig.store.retry_publish(job.job_id)

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    assert len(rig.fake_asr.calls) == 1 and len(rig.fake_writers.calls) == 1  # not re-run
    assert rig.bridge.calls  # publish did run


def test_retry_writer_skips_asr_and_uses_new_writer(rig: Rig) -> None:
    job = rig.queue("summarize")
    rig.run(job.job_id)
    rig.store.retry_writer(job.job_id, "codex")

    rec = rig.run(job.job_id)

    assert rec.status == "complete" and rec.writer == "codex"
    assert len(rig.fake_asr.calls) == 1
    assert rig.fake_writers.calls[-1]["writer"] == "codex"


def test_writer_none_completes_with_skipped_writer_log(rig: Rig) -> None:
    job = rig.queue("transcribe")
    rig.store.set_status(job.job_id, "queued", writer="none", summarize=True)

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    assert rig.fake_writers.calls == []
    assert "writer: skipped" in "\n".join(rig.store.read_log(job.job_id))


def test_retry_writer_rewrites_summary_and_archives_previous(rig: Rig) -> None:
    job = rig.queue("summarize")
    rig.run(job.job_id)
    outbox = rig.store.outbox_dir(RECORDING_ID)
    first = (outbox / "summary.md").read_text(encoding="utf-8")

    rig.store.retry_writer(job.job_id, "codex")
    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    archived = outbox / f"summary.{job.job_id}.md"
    assert archived.read_text(encoding="utf-8") == first
    assert (outbox / "summary.md").read_text(encoding="utf-8") != first


def test_asr_failure_sets_step_prefixed_error_and_no_transcript(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    rig.fake_asr.fail = True
    job = rig.queue("summarize")

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("asr:") and "whisper exploded" in rec.error
    assert not (rig.store.outbox_dir(RECORDING_ID) / "transcript.txt").is_file()
    assert rig.fake_writers.calls == []
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "asr" in warnings[0]


def test_writer_failure_keeps_transcript(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    rig.fake_writers.fail = True
    job = rig.queue("summarize")

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("writer:") and "claude CLI died" in rec.error
    assert (rig.store.outbox_dir(RECORDING_ID) / "transcript.txt").is_file()
    assert not (rig.store.outbox_dir(RECORDING_ID) / "summary.md").is_file()
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "writer" in warnings[0]


def test_publish_failure_keeps_summary(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("publish")

    def failing_bridge() -> FakeBridge:
        bridge = FakeBridge()
        bridge.fail_on = "set_theme"
        return bridge

    import r1cord_server.mddocs as mddocs_mod

    orig = mddocs_mod.MdDocsBridge
    mddocs_mod.MdDocsBridge = failing_bridge  # type: ignore[assignment]
    try:
        with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
            rec = rig.run(job.job_id)
    finally:
        mddocs_mod.MdDocsBridge = orig  # type: ignore[assignment]

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("publish:") and "set_theme" in rec.error
    summary = rig.store.outbox_dir(RECORDING_ID) / "summary.md"
    assert summary.is_file() and summary.read_text(encoding="utf-8").startswith("[brand-header]\n")
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "publish" in warnings[0]


def test_missing_audio_file_errors_asr_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("summarize")
    (rig.store.inbox_dir(RECORDING_ID) / "audio.m4a").unlink()

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "asr: no audio file in inbox"
    assert rig.fake_asr.calls == []
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0]


def test_only_publish_without_summary_errors_publish_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("summarize")
    rig.run(job.job_id)
    (rig.store.outbox_dir(RECORDING_ID) / "summary.md").unlink()
    rig.store.set_status(job.job_id, "queued", only_publish=True, skip_asr=True)

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "publish: summary.md is missing"
    assert len(rig.fake_asr.calls) == 1  # first pass only
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "publish" in warnings[0]


def test_only_publish_without_folder_errors_publish_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("summarize")
    rig.run(job.job_id)
    rig.store.set_status(job.job_id, "queued", only_publish=True, skip_asr=True, publish_folder="")

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "publish: publish folder is not set"
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0]


def test_worker_crash_is_recorded_as_error(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    job = rig.queue("summarize")

    def broken_append_log(job_id: str, line: str) -> None:
        raise RuntimeError("db gone")

    monkeypatch.setattr(rig.store, "append_log", broken_append_log)
    crash_worker = Worker(rig.store, rig.cfg)
    crash_worker.start()
    try:
        deadline = time.monotonic() + 10
        rec = None
        while time.monotonic() < deadline:
            rec = rig.store.job(job.job_id)
            if rec is not None and rec.status == "error":
                break
            time.sleep(0.02)
    finally:
        crash_worker.stop()

    assert rec is not None
    assert rec.status == "error" and rec.error == "worker: db gone"


def test_email_sent_only_when_enabled_and_complete(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[tuple] = []
    monkeypatch.setattr(mailer, "email_job", lambda store, config, job_id: sent.append((job_id, config.email_enabled)) or "mid-1")
    job = rig.queue("summarize")

    # Disabled in the default config: a complete job never triggers a send.
    rec = rig.run(job.job_id)
    rig.worker._email_if_complete(job.job_id)
    assert sent == []

    emailing = Worker(rig.store, replace(rig.cfg, email_enabled=True, email_to="me@example.test"))
    emailing._email_if_complete(job.job_id)
    assert sent == [(job.job_id, True)]

    # An errored job is never emailed even when enabled.
    failing = rig.queue("transcribe", recording_id="rec-worker-2")
    rig.fake_asr.fail = True
    emailing._run_job(rig.store.job(failing.job_id))  # type: ignore[arg-type]
    emailing._email_if_complete(failing.job_id)
    assert len(sent) == 1


def test_email_failure_logged_to_job_without_status_change(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken_email(store, config, job_id):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(mailer, "email_job", broken_email)
    emailing_worker = Worker(rig.store, replace(rig.cfg, email_enabled=True, email_to="me@example.test"))
    job = rig.queue("summarize")
    rig.worker._run_job(job)

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        emailing_worker._email_if_complete(job.job_id)

    rec = rig.store.job(job.job_id)
    assert rec is not None and rec.status == "complete"  # email failure never changes status
    assert "email: failed: smtp down" in "\n".join(rig.store.read_log(job.job_id))
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "email" in warnings[0]
