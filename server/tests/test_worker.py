from __future__ import annotations

import json
import logging
import time
from dataclasses import replace
from pathlib import Path

import pytest

from r1cord_server import mailer, naming, render
from r1cord_server.config import Config
from r1cord_server.pipeline import asr as asr_mod
from r1cord_server.pipeline import writers as writers_mod
from r1cord_server.pipeline.asr import AsrResult
from r1cord_server.pipeline.instructions import DEFAULT_PROMPTS, save_prompt
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
        self.fail_kinds: set[str] = set()

    def run_writer(self, work_dir: Path, *, kind: str, writer: str, timeout_s: int, config, log) -> Path:
        n = len(self.calls) + 1
        instructions = (work_dir / "INSTRUCTIONS.md").read_text(encoding="utf-8")
        self.calls.append(
            {"work": work_dir, "kind": kind, "writer": writer, "timeout_s": timeout_s, "instructions": instructions}
        )
        if self.fail or kind in self.fail_kinds:
            raise RuntimeError("claude CLI died")
        assert "Site visit" in instructions, "writer must receive INSTRUCTIONS.md with the title"
        assert f"Write ONLY {kind}.md" in instructions
        assert (work_dir / "transcript.txt").is_file()
        (work_dir / f"{kind}.md").write_text(f"# Site visit\n\n{kind} take {n}\n", encoding="utf-8")
        return work_dir / f"{kind}.md"


def _published(folder: Path) -> list[str]:
    """Kinds whose page is in the publish folder, in page order."""
    return [kind for kind in ("transcript", "summary", "outline", "organized") if (folder / f"{kind}.html").is_file()]


def _site(rig: Rig) -> Path:
    return rig.store.outbox_dir(RECORDING_ID) / "site"


class Rig:
    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.cfg = _cfg(tmp_path)
        self.store = JobStore(self.cfg)
        self.prompts = tmp_path / "prompts"
        self.worker = Worker(self.store, self.cfg, prompts_dir=self.prompts)
        self.fake_asr = FakeAsr()
        self.fake_writers = FakeWriters()
        monkeypatch.setattr(asr_mod, "transcribe", self.fake_asr.transcribe)
        monkeypatch.setattr(writers_mod, "run_writer", self.fake_writers.run_writer)

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

    def queue_reviews(self, reviews: tuple[str, ...], *, publish: bool, recording_id: str = RECORDING_ID):
        inbox = self.stage_recording(recording_id)
        return self.store.import_folder(inbox, title=None, reviews=reviews, publish=publish)

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


def test_transcribe_only_job_completes_and_builds_the_local_site_without_publishing(rig: Rig) -> None:
    job = rig.queue("transcribe")

    rec = rig.run(job.job_id)

    assert rec.status == "complete" and rec.error is None
    outbox = rig.store.outbox_dir(RECORDING_ID)
    assert (outbox / "transcript.txt").read_text(encoding="utf-8") == "hello world"
    page = (outbox / "transcript.md").read_text(encoding="utf-8")  # always written after ASR
    assert page.startswith("# Site visit\n") and "hello world" in page
    assert rig.fake_writers.calls == []
    assert (_site(rig) / "transcript.html").is_file()
    assert not Path(job.publish_folder).exists()  # built here, never deployed
    log_lines = "\n".join(rig.store.read_log(job.job_id))
    assert "asr: done" in log_lines and "writer: skipped" in log_lines and "publish: skipped" in log_lines
    assert rig.store.result_json(job.job_id)["webdavUrl"] is None


def test_review_without_publish_installs_summary_and_photos_and_builds_the_site(rig: Rig) -> None:
    job = rig.queue("review", photos=("photo-p1.jpg",))

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    outbox = rig.store.outbox_dir(RECORDING_ID)
    assert (outbox / "summary.md").read_text(encoding="utf-8").startswith("# Site visit\n")
    assert (outbox / "photos" / "photo-p1.jpg").is_file()
    assert (_site(rig) / "summary.html").is_file() and (_site(rig) / "transcript.html").is_file()
    assert not Path(job.publish_folder).exists()  # publish never ran
    assert rig.store.result_json(job.job_id)["pages"] == []
    assert rig.store.result_json(job.job_id)["webdavUrl"] is None
    call = rig.fake_writers.calls[0]
    assert call["timeout_s"] == rig.cfg.writer_timeout_s
    assert call["work"] == rig.store.work_dir(job.job_id) / "summary"  # each review in its own folder
    assert (call["work"] / "photos" / "photo-p1.jpg").is_file()


def test_publish_action_deploys_the_site_with_transcript_and_reviews(rig: Rig) -> None:
    job = rig.queue("publish")

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    folder = Path(job.publish_folder)
    result = rig.store.result_json(job.job_id)
    assert result["webdavUrl"] == naming.webdav_url(rig.cfg, folder, "summary.html")
    assert [p["kind"] for p in result["pages"]] == ["transcript", "summary"]
    assert _published(folder) == ["transcript", "summary"]
    assert (folder / "summary.md").read_text(encoding="utf-8") == "# Site visit\n\nsummary take 1\n"
    assert (folder / "summary.html").read_bytes() == (_site(rig) / "summary.html").read_bytes()
    log_lines = "\n".join(rig.store.read_log(job.job_id))
    assert "publish: wrote summary.html\n" in log_lines and "publish: done (transcript, summary)" in log_lines


def test_failed_review_does_not_stop_the_others_and_ends_in_error(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    rig.fake_writers.fail_kinds = {"outline"}
    job = rig.queue_reviews(("summary", "outline"), publish=True)

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("writer: outline: ") and "summary" not in rec.error
    outbox = rig.store.outbox_dir(RECORDING_ID)
    assert (outbox / "summary.md").is_file() and not (outbox / "outline.md").exists()
    assert _published(Path(job.publish_folder)) == ["transcript", "summary"]  # published what succeeded
    result = rig.store.result_json(job.job_id)
    assert result["reviews"] == ["summary", "outline"]
    assert [p["kind"] for p in result["pages"]] == ["transcript", "summary"]
    log_lines = "\n".join(rig.store.read_log(job.job_id))
    assert "writer: summary: done in" in log_lines and "writer: outline: failed" in log_lines
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "outline" in warnings[0]


def test_edited_prompt_reaches_instructions(rig: Rig) -> None:
    save_prompt(rig.prompts, "organized", "Keep every word the speaker said about fences.")
    job = rig.queue_reviews(("summary", "organized"), publish=False)

    rig.run(job.job_id)

    by_kind = {c["kind"]: c["instructions"] for c in rig.fake_writers.calls}
    assert "Keep every word the speaker said about fences." in by_kind["organized"]
    assert "Keep every word the speaker said about fences." not in by_kind["summary"]
    assert DEFAULT_PROMPTS["summary"].strip() in by_kind["summary"]


def test_add_review_skips_asr_and_publishes_like_the_latest_job(rig: Rig) -> None:
    first = rig.queue("publish")
    rig.run(first.job_id)

    added = rig.store.add_review(RECORDING_ID, "organized")
    rec = rig.run(added.job_id)

    assert rec.status == "complete"
    assert len(rig.fake_asr.calls) == 1
    assert [c["kind"] for c in rig.fake_writers.calls] == ["summary", "organized"]
    assert _published(Path(first.publish_folder)) == ["transcript", "summary", "organized"]
    pages = rig.store.result_json(added.job_id)["pages"]
    assert [p["kind"] for p in pages] == ["transcript", "summary", "organized"]


def test_only_publish_retry_skips_asr_and_writer_and_republishes_every_page(rig: Rig) -> None:
    job = rig.queue_reviews(("summary", "outline"), publish=False)
    rig.run(job.job_id)
    assert rig.fake_asr.calls and rig.fake_writers.calls
    (rig.store.outbox_dir(RECORDING_ID) / "transcript.md").unlink()  # rebuilt from transcript.txt
    rig.store.retry_publish(job.job_id)

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    assert len(rig.fake_asr.calls) == 1 and len(rig.fake_writers.calls) == 2  # not re-run
    assert _published(Path(job.publish_folder)) == ["transcript", "summary", "outline"]


def test_retry_writer_skips_asr_and_uses_new_writer(rig: Rig) -> None:
    job = rig.queue("review")
    rig.run(job.job_id)
    rig.store.retry_writer(job.job_id, "codex", ["outline"])

    rec = rig.run(job.job_id)

    assert rec.status == "complete" and rec.writer == "codex" and rec.reviews == ("outline",)
    assert len(rig.fake_asr.calls) == 1
    assert rig.fake_writers.calls[-1]["writer"] == "codex" and rig.fake_writers.calls[-1]["kind"] == "outline"


def test_writer_none_completes_with_skipped_writer_log(rig: Rig) -> None:
    job = rig.queue("transcribe")
    rig.store.set_status(job.job_id, "queued", writer="none", reviews=("summary",))

    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    assert rig.fake_writers.calls == []
    assert "writer: skipped" in "\n".join(rig.store.read_log(job.job_id))


def test_retry_writer_rewrites_review_and_archives_previous(rig: Rig) -> None:
    job = rig.queue("review")
    rig.run(job.job_id)
    outbox = rig.store.outbox_dir(RECORDING_ID)
    first = (outbox / "summary.md").read_text(encoding="utf-8")

    rig.store.retry_writer(job.job_id, "codex")
    rec = rig.run(job.job_id)

    assert rec.status == "complete"
    archived = outbox / f"summary.{job.job_id}.md"
    assert archived.read_text(encoding="utf-8") == first
    assert (outbox / "summary.md").read_text(encoding="utf-8") != first

    # A later job rewriting it names the archive after the job that wrote the replaced copy.
    second = (outbox / "summary.md").read_text(encoding="utf-8")
    added = rig.store.add_review(RECORDING_ID, "summary")
    rig.run(added.job_id)
    assert (outbox / f"summary.{job.job_id}-2.md").read_text(encoding="utf-8") == second


def test_asr_failure_sets_step_prefixed_error_and_no_transcript(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    rig.fake_asr.fail = True
    job = rig.queue("review")

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
    job = rig.queue("review")

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("writer:") and "claude CLI died" in rec.error
    assert (rig.store.outbox_dir(RECORDING_ID) / "transcript.txt").is_file()
    assert not (rig.store.outbox_dir(RECORDING_ID) / "summary.md").is_file()
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "writer" in warnings[0]


def test_publish_failure_keeps_summary_and_the_local_site(
    rig: Rig, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = rig.queue("publish")

    def unreachable(src: Path, dest: Path) -> list[str]:
        raise OSError("WebDAV mount is gone")

    monkeypatch.setattr(render, "deploy_site", unreachable)
    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error"
    assert rec.error is not None and rec.error.startswith("publish:") and "WebDAV mount is gone" in rec.error
    summary = rig.store.outbox_dir(RECORDING_ID) / "summary.md"
    assert summary.is_file() and summary.read_text(encoding="utf-8").startswith("# Site visit\n")
    assert (_site(rig) / "summary.html").is_file()  # the local view still has it
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "publish" in warnings[0]


def test_missing_audio_file_errors_asr_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("review")
    (rig.store.inbox_dir(RECORDING_ID) / "audio.m4a").unlink()

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "asr: no audio file in inbox"
    assert rig.fake_asr.calls == []
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0]


def test_only_publish_with_nothing_to_publish_errors_publish_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("review")
    rig.run(job.job_id)
    outbox = rig.store.outbox_dir(RECORDING_ID)
    for name in ("summary.md", "transcript.md", "transcript.txt"):
        (outbox / name).unlink()
    rig.store.set_status(job.job_id, "queued", only_publish=True, skip_asr=True)

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "publish: nothing to publish (no transcript or AI review yet)"
    assert len(rig.fake_asr.calls) == 1  # first pass only
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "publish" in warnings[0]


def test_only_publish_without_folder_errors_publish_step(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    job = rig.queue("review")
    rig.run(job.job_id)
    rig.store.set_status(job.job_id, "queued", only_publish=True, skip_asr=True, publish_folder="")

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        rec = rig.run(job.job_id)

    assert rec.status == "error" and rec.error == "publish: publish folder is not set"
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0]


def test_worker_crash_is_recorded_as_error(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    job = rig.queue("review")

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
    job = rig.queue("review")

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
    job = rig.queue("review")
    rig.worker._run_job(job)

    with caplog.at_level(logging.WARNING, logger="r1cord_server.worker"):
        emailing_worker._email_if_complete(job.job_id)

    rec = rig.store.job(job.job_id)
    assert rec is not None and rec.status == "complete"  # email failure never changes status
    assert "email: failed: smtp down" in "\n".join(rig.store.read_log(job.job_id))
    warnings = _warnings(caplog)
    assert len(warnings) == 1 and job.job_id in warnings[0] and "email" in warnings[0]
