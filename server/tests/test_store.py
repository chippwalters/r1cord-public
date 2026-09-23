from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import sqlite3
from dataclasses import replace

import pytest

from r1cord_server import store as store_module
from r1cord_server.config import Config
from r1cord_server.store import (
    ACTIVE_STATUSES,
    AudioMismatch,
    FileSpec,
    HashMismatch,
    Incomplete,
    JobActive,
    JobNotUploading,
    JobRequest,
    JobStore,
    OffsetMismatch,
    RetryNotAllowed,
    StoreError,
    TooLarge,
    UnknownJob,
    hash_token,
)


def _cfg(tmp_path: Path) -> Config:
    return Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://example.test/files",
        admin_password="test-admin-pass1",
    )


def _audio_spec(data: bytes, name: str = "audio.m4a") -> tuple[FileSpec, bytes]:
    return FileSpec(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest()), data


def _request(recording_id: str, spec: FileSpec, title: str = "Site visit") -> JobRequest:
    return JobRequest(
        recording_id=recording_id,
        created_at_ms=1_758_400_000_000,
        title=title,
        reviews=("summary",),
        publish=True,
        files=(spec,),
    )


def test_pair_code_single_use_and_expiry(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    code = store.create_pair_code()
    assert len(code) == 6 and code.isdigit()
    token = store.redeem_pair_code(code, "device")
    assert token is not None
    assert len(token) == 64
    assert store.token_valid(token)
    assert store.redeem_pair_code(code, "device") is None

    expired = store.create_pair_code()
    store._conn.execute(
        "UPDATE pair_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE code = ?",
        (expired,),
    )
    store._conn.commit()
    assert store.redeem_pair_code(expired, "device") is None
    assert not store.token_valid("0" * 64)


def test_job_active_and_reuse_after_complete(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"audio-bytes-01")
    rec = store.create_job(_request("rec-1", spec), {"id": "rec-1", "title": "Site visit"})
    with pytest.raises(JobActive) as active:
        store.create_job(_request("rec-1", spec), {"id": "rec-1"})
    assert active.value.job_id == rec.job_id

    store.append_file(rec.job_id, spec.name, 0, iter([data]))
    queued = store.commit(rec.job_id)
    assert queued.status == "queued"
    store.set_status(rec.job_id, "complete")

    again = store.create_job(_request("rec-1", spec), {"id": "rec-1", "title": "Site visit"})
    assert again.job_id != rec.job_id
    assert again.status == "uploading"
    assert store.file_received(again.job_id, spec.name) == spec.size
    committed = store.commit(again.job_id)
    assert committed.status == "queued"


def test_audio_mismatch(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"original-audio")
    rec = store.create_job(_request("rec-2", spec), {"id": "rec-2"})
    store.append_file(rec.job_id, spec.name, 0, iter([data]))
    store.commit(rec.job_id)
    store.set_status(rec.job_id, "complete")

    other, _ = _audio_spec(b"different-audio")
    with pytest.raises(AudioMismatch):
        store.create_job(_request("rec-2", other), {"id": "rec-2"})


def test_append_offset_and_hash_mismatch_deletes_partial(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    data = b"abcdefghij"
    spec, _ = _audio_spec(data)
    rec = store.create_job(_request("rec-3", spec), {"id": "rec-3"})
    assert store.file_received(rec.job_id, spec.name) == 0

    store.append_file(rec.job_id, spec.name, 0, iter([data[:4]]))
    assert store.file_received(rec.job_id, spec.name) == 4
    with pytest.raises(OffsetMismatch) as mismatch:
        store.append_file(rec.job_id, spec.name, 0, iter([b"xxxx"]))
    assert mismatch.value.received == 4

    store.append_file(rec.job_id, spec.name, 4, iter([b"XXXXXX"]))
    assert store.file_received(rec.job_id, spec.name) == 10
    with pytest.raises(HashMismatch) as hashed:
        store.commit(rec.job_id)
    assert spec.name in hashed.value.files
    partial = store.inbox_dir("rec-3") / ".upload" / f"{spec.name}.partial"
    assert not partial.exists()
    assert store.file_received(rec.job_id, spec.name) == 0

    store.append_file(rec.job_id, spec.name, 0, iter([data[:3]]))
    with pytest.raises(Incomplete):
        store.commit(rec.job_id)


def test_import_folder(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    src = tmp_path / "drop"
    src.mkdir()
    audio = b"imported-audio"
    (src / "audio.wav").write_bytes(audio)
    (src / "metadata.json").write_text(
        '{"schemaVersion":1,"id":"rec-drop","title":"Dropped","createdAt":1758400000000}',
        encoding="utf-8",
    )
    rec = store.import_folder(src, title=None, reviews=("summary",), publish=False)
    assert rec.recording_id == "rec-drop"
    assert rec.status == "queued"
    assert rec.title == "Dropped"
    assert rec.publish is False
    assert (store.inbox_dir("rec-drop") / "audio.wav").is_file()


# --- create_job validation -------------------------------------------------


def _valid_request(spec: FileSpec, **overrides: object) -> JobRequest:
    base: dict[str, object] = dict(
        recording_id="rec-v",
        created_at_ms=1_758_400_000_000,
        title="Site visit",
        reviews=("summary",),
        publish=False,
        files=(spec,),
    )
    base.update(overrides)
    return JobRequest(**base)  # type: ignore[arg-type]


def test_create_job_rejects_bad_requests(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, _ = _audio_spec(b"valid-audio")
    other, _ = _audio_spec(b"other-audio", name="audio.wav")
    cases: list[tuple[str, JobRequest, str]] = [
        ("empty title", _valid_request(spec, title="   "), "title"),
        ("long title", _valid_request(spec, title="x" * 121), "title"),
        ("unknown review", _valid_request(spec, reviews=("summary", "poem")), "unknown review"),
        ("empty recording id", _valid_request(spec, recording_id=""), "recordingId"),
        ("slash in id", _valid_request(spec, recording_id="a/b"), "recordingId"),
        ("backslash in id", _valid_request(spec, recording_id="a\\b"), "recordingId"),
        ("dotdot id", _valid_request(spec, recording_id=".."), "recordingId"),
        ("padded id", _valid_request(spec, recording_id=" rec"), "recordingId"),
        ("empty manifest", _valid_request(spec, files=()), "manifest"),
        ("duplicate name", _valid_request(spec, files=(spec, spec)), "duplicate"),
        ("stray file", _valid_request(spec, files=(spec, FileSpec("notes.txt", 1, "0" * 64))), "not allowed"),
        ("bad photo ext", _valid_request(spec, files=(spec, FileSpec("photo-x.png", 1, "0" * 64))), "not allowed"),
        ("negative size", _valid_request(spec, files=(FileSpec("audio.m4a", -1, "0" * 64),)), "size"),
        ("short sha", _valid_request(spec, files=(FileSpec("audio.m4a", 4, "0" * 63),)), "sha256"),
        ("non-hex sha", _valid_request(spec, files=(FileSpec("audio.m4a", 4, "z" * 64),)), "sha256"),
        ("two audios", _valid_request(spec, files=(spec, other)), "exactly one"),
    ]
    for name, req, fragment in cases:
        with pytest.raises(ValueError, match=fragment):
            store.create_job(req, {"id": req.recording_id})
        assert not (Path(_cfg(tmp_path).datastore) / "rec-v").exists(), name


def test_dotdot_recording_id_cannot_escape_inbox(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, _ = _audio_spec(b"escape-attempt")
    with pytest.raises(ValueError, match="recordingId"):
        store.create_job(_valid_request(spec, recording_id=".."), {"id": ".."})
    # Nothing may land outside inbox/: the datastore root itself must stay clean.
    assert not (tmp_path / "ds" / "metadata.json").exists()
    assert not (tmp_path / "ds" / "audio.m4a").exists()


def test_inbox_and_outbox_dirs_reject_escaping_ids(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    for bad in ("..", "a/b", "a\\b", " rec", ""):
        with pytest.raises(ValueError, match="recordingId"):
            store.inbox_dir(bad)
        with pytest.raises(ValueError, match="recordingId"):
            store.outbox_dir(bad)


# --- job lifecycle -----------------------------------------------------------


@pytest.mark.parametrize("status", ACTIVE_STATUSES)
def test_active_job_blocks_new_job_until_terminal(tmp_path: Path, status: str) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"lifecycle-audio")
    rec = store.create_job(_valid_request(spec), {"id": "rec-v"})
    if status != "uploading":
        store.append_file(rec.job_id, spec.name, 0, iter([data]))
        store.commit(rec.job_id)
        store.set_status(rec.job_id, status)
    assert store.has_active_jobs() is True
    active = store.active_job_for("rec-v")
    assert active is not None and active.job_id == rec.job_id
    with pytest.raises(JobActive) as exc:
        store.create_job(_valid_request(spec), {"id": "rec-v"})
    assert exc.value.job_id == rec.job_id

    store.set_status(rec.job_id, "error", error="boom")
    assert store.has_active_jobs() is False
    assert store.active_job_for("rec-v") is None
    again = store.create_job(_valid_request(spec), {"id": "rec-v"})
    assert again.job_id != rec.job_id


def test_second_job_reuses_publish_folder_and_keeps_history(tmp_path: Path) -> None:
    """The webdav URL is stable across jobs; result.json history feeds the
    worker's summary.<jobId>.md archive naming for earlier summaries."""
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"reuse-audio")
    first = store.create_job(_valid_request(spec, publish=True), {"id": "rec-v"})
    store.append_file(first.job_id, spec.name, 0, iter([data]))
    store.commit(first.job_id)
    store.set_status(first.job_id, "complete")

    second = store.create_job(_valid_request(spec, publish=True), {"id": "rec-v"})
    assert second.publish_folder == first.publish_folder
    assert second.webdav_url == first.webdav_url

    result = store.result_json(second.job_id)
    assert [h["jobId"] for h in result["history"]] == [first.job_id, second.job_id]
    first_entry, second_entry = result["history"]
    assert first_entry["status"] == "complete" and first_entry["finishedAt"]
    assert second_entry["finishedAt"] is None


def test_set_status_transitions_timings_and_asr(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"timings-audio")
    rec = store.create_job(_valid_request(spec), {"id": "rec-v"})
    store.append_file(rec.job_id, spec.name, 0, iter([data]))
    store.commit(rec.job_id)

    with pytest.raises(UnknownJob):
        store.set_status("no-such-job", "queued")

    store.set_status(
        rec.job_id,
        "transcribed",
        asr={"model": "large-v3-turbo", "device": "cuda", "language": "en", "duration_s": 10},
    )
    job = store.job(rec.job_id)
    assert job is not None and job.error is None and job.finished_at is None
    result = store.result_json(rec.job_id)
    assert result["asr"] == {"model": "large-v3-turbo", "device": "cuda", "language": "en"}

    store.set_status(rec.job_id, "error", error="writer: nope")
    job = store.job(rec.job_id)
    assert job is not None and job.error == "writer: nope" and job.finished_at is not None

    store.set_status(rec.job_id, "queued")
    job = store.job(rec.job_id)
    assert job is not None and job.error is None and job.finished_at is None

    store.set_status(rec.job_id, "complete", timings={"asr": 11, "writer": 22, "publish": 33})
    job = store.job(rec.job_id)
    assert job is not None and job.finished_at is not None
    assert job.timings == {"asr": 11, "writer": 22, "publish": 33}
    assert store.result_json(rec.job_id)["timingsMs"] == {"asr": 11, "writer": 22, "publish": 33}


def test_result_json_written_to_outbox(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, _ = _audio_spec(b"result-audio")
    rec = store.create_job(_valid_request(spec, publish=False), {"id": "rec-v"})
    outbox = tmp_path / "ds" / "outbox" / "rec-v" / "result.json"
    assert outbox.is_file()
    assert json.loads(outbox.read_text(encoding="utf-8"))["jobId"] == rec.job_id
    store.set_status(rec.job_id, "queued")
    assert json.loads(outbox.read_text(encoding="utf-8"))["status"] == "queued"
    result = store.result_json(rec.job_id)
    assert result["webdavUrl"] is None  # publish=False gates the URL


def test_recent_jobs_ordering_with_clock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(_cfg(tmp_path))
    stamps = iter(f"2026-01-01T00:00:{i:02d}Z" for i in range(10))
    monkeypatch.setattr(store_module, "utcnow_iso", lambda: next(stamps))
    spec, _ = _audio_spec(b"order-audio")
    a = store.create_job(_valid_request(spec, recording_id="rec-a"), {"id": "rec-a"})
    b = store.create_job(_valid_request(spec, recording_id="rec-b"), {"id": "rec-b"})
    assert [j.job_id for j in store.recent_jobs()] == [b.job_id, a.job_id]
    store.set_status(a.job_id, "queued")
    assert [j.job_id for j in store.recent_jobs()] == [a.job_id, b.job_id]


def test_next_queued_is_fifo_even_with_equal_created_at(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, data = _audio_spec(b"fifo-audio")
    first = store.create_job(_valid_request(spec, recording_id="rec-a"), {"id": "rec-a"})
    second = store.create_job(_valid_request(spec, recording_id="rec-b"), {"id": "rec-b"})
    assert store.next_queued() is None
    store.append_file(first.job_id, spec.name, 0, iter([data]))
    store.append_file(second.job_id, spec.name, 0, iter([data]))
    store.commit(first.job_id)
    store.commit(second.job_id)
    assert store.next_queued() is not None and store.next_queued().job_id == first.job_id

def test_recordings_index_latest_job_and_publish_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(_cfg(tmp_path))
    stamps = iter(f"2026-01-01T00:00:{i:02d}Z" for i in range(10))
    monkeypatch.setattr(store_module, "utcnow_iso", lambda: next(stamps))
    spec, data = _audio_spec(b"index-audio")
    pub = store.create_job(
        _valid_request(spec, recording_id="rec-pub", publish=True), {"id": "rec-pub"}
    )
    store.append_file(pub.job_id, spec.name, 0, iter([data]))
    store.commit(pub.job_id)
    store.set_status(pub.job_id, "complete")
    priv = store.create_job(
        _valid_request(spec, recording_id="rec-priv", publish=False), {"id": "rec-priv"}
    )

    index = store.recordings_index()
    assert [r.recording_id for r in index] == ["rec-priv", "rec-pub"]  # newest first
    by_id = {r.recording_id: r for r in index}
    assert by_id["rec-pub"].webdav_url is not None and by_id["rec-pub"].status == "complete"
    assert by_id["rec-priv"].webdav_url is None  # publish=False hides the URL


# --- upload guards -----------------------------------------------------------


def test_append_too_large_rolls_back_and_rejects_after_commit(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    data = b"0123456789"
    spec, _ = _audio_spec(data)
    rec = store.create_job(_valid_request(spec), {"id": "rec-v"})

    assert store.file_received(rec.job_id, "bogus.txt") is None
    store.append_file(rec.job_id, spec.name, 0, iter([data[:4]]))
    with pytest.raises(TooLarge) as too_large:
        store.append_file(rec.job_id, spec.name, 4, iter([b"x" * 100]))
    assert too_large.value.size == len(data)
    assert store.file_received(rec.job_id, spec.name) == 4  # rolled back to the offset

    store.append_file(rec.job_id, spec.name, 4, iter([data[4:]]))
    assert store.append_file(rec.job_id, spec.name, len(data), iter([])) == len(data)
    with pytest.raises(TooLarge):
        store.append_file(rec.job_id, spec.name, len(data), iter([b"extra"]))

    store.commit(rec.job_id)
    with pytest.raises(JobNotUploading):
        store.append_file(rec.job_id, spec.name, len(data), iter([]))


# --- retries -------------------------------------------------------------------


def _finished_job(store: JobStore, recording_id: str, status: str) -> JobRecord:
    spec, data = _audio_spec(b"retry-audio")
    rec = store.create_job(_valid_request(spec, recording_id=recording_id), {"id": recording_id})
    store.append_file(rec.job_id, spec.name, 0, iter([data]))
    store.commit(rec.job_id)
    if status != "queued":
        store.set_status(rec.job_id, status, error="boom" if status == "error" else None)
    return rec


def test_retry_writer_refusals(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    with pytest.raises(UnknownJob):
        store.retry_writer("no-such-job", None)

    queued = _finished_job(store, "rec-q", "queued")
    with pytest.raises(RetryNotAllowed, match="status queued"):
        store.retry_writer(queued.job_id, "codex")

    complete = _finished_job(store, "rec-c", "complete")
    with pytest.raises(RetryNotAllowed, match="transcript.txt is missing"):
        store.retry_writer(complete.job_id, "codex")

    transcript = store.outbox_dir("rec-c") / "transcript.txt"
    transcript.write_text("hello", encoding="utf-8")
    with pytest.raises(RetryNotAllowed, match="invalid writer"):
        store.retry_writer(complete.job_id, "none")
    with pytest.raises(RetryNotAllowed, match="invalid writer"):
        store.retry_writer(complete.job_id, "bogus")


def test_retry_writer_from_terminal_and_error(tmp_path: Path) -> None:
    for status in ("complete", "error"):
        store = JobStore(_cfg(tmp_path / status))
        rec = _finished_job(store, "rec-retry", status)
        (store.outbox_dir("rec-retry") / "transcript.txt").write_text("hello", encoding="utf-8")
        retried = store.retry_writer(rec.job_id, "codex")
        assert retried.status == "queued"
        assert retried.writer == "codex"
        assert retried.skip_asr is True and retried.only_publish is False
        store.set_status(rec.job_id, "complete")
        keep = store.retry_writer(rec.job_id, None)
        assert keep.writer == "codex"  # no override keeps the current writer


def test_retry_publish_contract(tmp_path: Path) -> None:
    """retry-publish is allowed once there is a page to publish: a transcript or any AI review."""
    store = JobStore(_cfg(tmp_path))
    with pytest.raises(UnknownJob):
        store.retry_publish("no-such-job")

    rec = _finished_job(store, "rec-retry", "error")
    with pytest.raises(RetryNotAllowed, match="nothing to publish"):
        store.retry_publish(rec.job_id)

    (store.outbox_dir("rec-retry") / "outline.md").write_text("# Outline", encoding="utf-8")
    retried = store.retry_publish(rec.job_id)
    assert retried.status == "queued"
    assert retried.skip_asr is True and retried.only_publish is True


# --- import / process_inbox ------------------------------------------------


def _write_drop(folder: Path, recording_id: str, *, title: str = "Dropped", created: int = 1758400000000) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "audio.wav").write_bytes(b"imported-audio")
    (folder / "metadata.json").write_text(
        json.dumps({"schemaVersion": 1, "id": recording_id, "title": title, "createdAt": created}),
        encoding="utf-8",
    )


def test_import_folder_error_paths(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    with pytest.raises(FileNotFoundError):
        store.import_folder(tmp_path / "missing", title=None, reviews=("summary",), publish=False)

    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(FileNotFoundError, match="metadata.json"):
        store.import_folder(empty, title=None, reviews=("summary",), publish=False)

    no_id = tmp_path / "no-id"
    _write_drop(no_id, "")
    with pytest.raises(ValueError, match="missing id"):
        store.import_folder(no_id, title=None, reviews=("summary",), publish=False)

    escape = tmp_path / "escape"
    _write_drop(escape, "..")
    with pytest.raises(ValueError, match="recordingId"):
        store.import_folder(escape, title=None, reviews=("summary",), publish=False)
    assert not (tmp_path / "ds" / "audio.wav").exists()  # nothing copied outside inbox/

    not_object = tmp_path / "not-object"
    not_object.mkdir()
    (not_object / "audio.wav").write_bytes(b"x")
    (not_object / "metadata.json").write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError, match="not an object"):
        store.import_folder(not_object, title=None, reviews=("summary",), publish=False)

    no_audio = tmp_path / "no-audio"
    no_audio.mkdir()
    (no_audio / "metadata.json").write_text('{"id":"rec-noaudio"}', encoding="utf-8")
    with pytest.raises(ValueError, match="exactly one"):
        store.import_folder(no_audio, title=None, reviews=("summary",), publish=False)

    two_audios = tmp_path / "two-audios"
    _write_drop(two_audios, "rec-two")
    (two_audios / "audio.m4a").write_bytes(b"second-audio")
    with pytest.raises(ValueError, match="exactly one"):
        store.import_folder(two_audios, title=None, reviews=("summary",), publish=False)

    bad_review = tmp_path / "bad-review"
    _write_drop(bad_review, "rec-review")
    with pytest.raises(ValueError, match="unknown review"):
        store.import_folder(bad_review, title=None, reviews=("poem",), publish=False)


def test_import_folder_metadata_variants(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))

    explicit = tmp_path / "explicit"
    _write_drop(explicit, "rec-meta1", title="From Metadata")
    rec = store.import_folder(explicit, title=None, reviews=("organized", "summary", "organized"), publish=False)
    assert rec.title == "From Metadata"
    assert rec.created_at_ms == 1_758_400_000_000
    assert rec.reviews == ("summary", "organized")  # canonical order, duplicates dropped
    assert (store.inbox_dir("rec-meta1") / "metadata.json").is_file()

    override = tmp_path / "override"
    _write_drop(override, "rec-meta2", title="Ignored")
    rec = store.import_folder(override, title="Kept", reviews=(), publish=False)
    assert rec.title == "Kept" and rec.reviews == ()

    fallback = tmp_path / "fallback"
    _write_drop(fallback, "rec-meta3", title="   ")
    rec = store.import_folder(fallback, title=None, reviews=("summary",), publish=False)
    assert rec.title == "recording"

    long_title = tmp_path / "long"
    _write_drop(long_title, "rec-meta4", title="t" * 500)
    rec = store.import_folder(long_title, title=None, reviews=("summary",), publish=False)
    assert len(rec.title) == 120

    no_created = tmp_path / "no-created"
    _write_drop(no_created, "rec-meta5", created=0)
    before_ms = int(time.time() * 1000)
    rec = store.import_folder(no_created, title=None, reviews=("summary",), publish=False)
    assert before_ms - 60_000 <= rec.created_at_ms <= int(time.time() * 1000) + 60_000


def test_import_folder_includes_photos_and_ignores_others(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    src = tmp_path / "photos"
    _write_drop(src, "rec-photos")
    (src / "photo-b.jpg").write_bytes(b"pb")
    (src / "photo-a.jpg").write_bytes(b"pa")
    (src / "photo-c.gif").write_bytes(b"pc")  # wrong extension: ignored
    (src / "notes.txt").write_text("x", encoding="utf-8")  # stray file: ignored
    rec = store.import_folder(src, title=None, reviews=("summary",), publish=False)
    names = [f.name for f in rec.files]
    assert names == ["audio.wav", "photo-a.jpg", "photo-b.jpg"]  # sorted after audio


def test_process_inbox_actions(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    store = JobStore(replace(cfg, default_reviews=("outline", "organized")))
    for rid, action, reviews, publish in [
        ("rec-act1", "transcribe", (), False),
        ("rec-act2", "review", ("outline", "organized"), False),
        ("rec-act3", "publish", ("outline", "organized"), True),
    ]:
        _write_drop(store.inbox_dir(rid), rid, title=f"USB {rid}")
        rec = store.process_inbox(rid, action=action)
        assert rec.status == "queued"
        assert rec.reviews == reviews and rec.publish is publish
        assert rec.title == f"USB {rid}"
    with pytest.raises(ValueError, match="invalid action"):
        store.process_inbox("rec-act4", action="archive")
    with pytest.raises(ValueError, match="invalid action"):
        store.process_inbox("rec-act4", action="summarize")
    with pytest.raises(ValueError, match="invalid action"):
        store.process_inbox("rec-act4", action="detonate")


def test_process_inbox_title_override(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    _write_drop(store.inbox_dir("rec-t"), "rec-t", title="Old")
    rec = store.process_inbox("rec-t", action="transcribe", title="New")
    assert rec.title == "New"


# --- device ledger -----------------------------------------------------------


def test_device_ledger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(_cfg(tmp_path))
    stamps = iter(f"2026-01-01T00:{i:02d}:00Z" for i in range(30))
    monkeypatch.setattr(store_module, "utcnow_iso", lambda: next(stamps))

    store.upsert_device_seen("s1", "Model A")
    store.upsert_device_seen("s1", "")  # empty model must not erase the known one
    store.upsert_device_seen("s2", "Model B")
    store.upsert_device_seen("s3", "Model C")
    assert [(d.serial, d.model) for d in store.devices()] == [
        ("s3", "Model C"),
        ("s2", "Model B"),
        ("s1", "Model A"),
    ]
    assert store.adopted_serials() == set()

    store.adopt_device("s1")
    store.adopt_device("s-never-seen")  # adopting an unseen serial still records it
    assert store.adopted_serials() == {"s1", "s-never-seen"}
    ordered = [d.serial for d in store.devices()]
    assert ordered[:2] == ["s1", "s-never-seen"]  # adopted first, then last_seen DESC
    assert ordered[2:] == ["s3", "s2"]

    store.device_synced("s2", None)
    store.device_synced("s1", "adb: no route")
    by_serial = {d.serial: d for d in store.devices()}
    assert by_serial["s2"].last_sync_at is not None and by_serial["s2"].last_error is None
    assert by_serial["s1"].last_error == "adb: no route"

    store.forget_device("s1")
    by_serial = {d.serial: d for d in store.devices()}
    assert by_serial["s1"].adopted is False
    assert by_serial["s1"].last_error is None
    assert by_serial["s1"].last_seen_at is not None  # history survives forget
    assert store.adopted_serials() == {"s-never-seen"}


def test_device_recording_ledger(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, _ = _audio_spec(b"ledger-audio")
    job = store.create_job(_valid_request(spec, recording_id="rec-d1"), {"id": "rec-d1"})

    store.mark_device_recording("s1", "rec-d1", device_status="FINISHED", title="Ledgered", created_at_ms=2000)
    store.mark_device_recording("s1", "rec-d0", device_status="FINISHED", title="Older", created_at_ms=1000)
    store.mark_device_recording("s1", "rec-d1", device_status="UPDATED", title="Renamed", created_at_ms=2000)
    store.flag_changed_since_job("s1", "rec-d1")
    store.device_recording_pulled("s1", "rec-d0")
    store.record_pulled_file("s1", "rec-d0", "audio.wav", 13, 100, "a" * 64)
    store.record_pulled_file("s1", "rec-d0", "photo-a.jpg", 2, 100, "b" * 64)
    store.set_auto_job("s1", "rec-d1", job.job_id)

    recs = store.device_recordings("s1")
    assert [r.recording_id for r in recs] == ["rec-d1", "rec-d0"]  # created_at DESC
    d1, d0 = recs
    assert d1.title == "Renamed" and d1.device_status == "UPDATED"
    assert d1.auto_job_id == job.job_id and d1.changed_since_job is False  # set_auto_job clears the flag
    assert d1.latest_job is not None and d1.latest_job.job_id == job.job_id
    assert d0.pulled_at is not None and d0.file_count == 2 and d0.bytes == 15
    assert store.device_file_state("s1", "rec-d0") == {
        "audio.wav": (13, 100),
        "photo-a.jpg": (2, 100),
    }

    store.flag_device_recording("s1", "rec-d1", "pull_failed")
    assert store.device_recordings("s1")[0].flag == "pull_failed"
    store.flag_device_recording("s1", "rec-d1", None)
    assert store.device_recordings("s1")[0].flag is None


# --- tokens and pair codes ---------------------------------------------------


def test_token_lifecycle(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    code = store.create_pair_code()
    raw = store.redeem_pair_code(code, "phone")
    assert raw is not None
    assert not store.token_valid("garbage")

    (entry,) = store.tokens()
    assert entry.sha256 == hash_token(raw)  # stored hashed, never the raw token
    assert entry.label == "phone" and entry.revoked is False and entry.last_used_at is None

    assert store.token_valid(raw) is True
    entry = store.tokens()[0]
    assert entry.last_used_at is not None

    second_code = store.create_pair_code()
    second = store.redeem_pair_code(second_code, "tablet")
    assert second is not None
    ids = [t.id for t in store.tokens()]
    assert ids == sorted(ids, reverse=True)  # newest first

    store.revoke_token(entry.id)
    assert store.token_valid(raw) is False
    assert store.tokens()[0].revoked is False  # only the targeted token


def test_pair_code_ttl_expiry_via_clock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(_cfg(tmp_path))
    code = store.create_pair_code()  # expires pair_code_ttl_s from now (600s default)
    monkeypatch.setattr(store_module, "utcnow_iso", lambda: "2999-01-01T00:00:00Z")
    assert store.redeem_pair_code(code, "phone") is None


# --- logs ---------------------------------------------------------------------


def test_append_and_read_log(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    spec, _ = _audio_spec(b"log-audio")
    rec = store.create_job(_valid_request(spec), {"id": "rec-v"})
    store.append_log(rec.job_id, "step one")
    store.append_log(rec.job_id, "step two\n")
    lines = store.read_log(rec.job_id)
    assert [ln.split(" ", 1)[1] for ln in lines] == ["step one", "step two"]
    assert store.read_log(rec.job_id, tail=1) == [lines[1]]
    with pytest.raises(UnknownJob):
        store.read_log("no-such-job")


# --- audio mismatch across names ---------------------------------------------


def test_audio_mismatch_across_different_audio_names(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    m4a, data = _audio_spec(b"same-bytes")  # audio.m4a
    rec = store.create_job(_valid_request(m4a, recording_id="rec-am"), {"id": "rec-am"})
    store.append_file(rec.job_id, m4a.name, 0, iter([data]))
    store.commit(rec.job_id)
    store.set_status(rec.job_id, "complete")

    same_bytes_wav, _ = _audio_spec(b"same-bytes", name="audio.wav")
    store.create_job(_valid_request(same_bytes_wav, recording_id="rec-am"), {"id": "rec-am"})  # same content: fine
    store.set_status(store.active_job_for("rec-am").job_id, "error")

    other_wav, _ = _audio_spec(b"different-bytes", name="audio.wav")
    with pytest.raises(AudioMismatch):
        store.create_job(_valid_request(other_wav, recording_id="rec-am"), {"id": "rec-am"})


def _rerun(store: JobStore, recording_id: str, status: str) -> JobRecord:
    """Another job for a recording whose audio is already here: nothing to upload, commit directly."""
    spec, _ = _audio_spec(b"retry-audio")
    rec = store.create_job(_valid_request(spec, recording_id=recording_id), {"id": recording_id})
    store.commit(rec.job_id)
    store.set_status(rec.job_id, status)
    return rec


def test_delete_recording_removes_this_pcs_copy_and_nothing_outside_the_publish_root(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    rec = _finished_job(store, "rec-del", "complete")
    ds = tmp_path / "ds"
    published = Path(store.job(rec.job_id).publish_folder)
    published.mkdir(parents=True)
    (published / "summary.html").write_text("page", encoding="utf-8")
    (ds / "work" / "rec-del").mkdir(parents=True, exist_ok=True)
    store.outbox_dir("rec-del")
    # A second run whose recorded publish folder points outside webdav_folder (moved config, bad row).
    second = _rerun(store, "rec-del", "complete")
    outside = tmp_path / "not-published-here"
    outside.mkdir()
    store._conn.execute("UPDATE jobs SET publish_folder = ? WHERE job_id = ?", (str(outside), second.job_id))
    store._conn.commit()

    store.delete_recording("rec-del")

    for gone in (ds / "inbox" / "rec-del", ds / "outbox" / "rec-del", ds / "work" / "rec-del", published):
        assert not gone.exists(), gone
    assert outside.is_dir()
    assert store.latest_for("rec-del") is None and store.is_deleted("rec-del")
    # An explicit Send / Import of the same recording clears the mark.
    _finished_job(store, "rec-del", "queued")
    assert not store.is_deleted("rec-del")


def test_delete_recording_refuses_while_a_job_is_running(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    _finished_job(store, "rec-busy", "transcribing")
    with pytest.raises(StoreError, match="still running"):
        store.delete_recording("rec-busy")
    assert (tmp_path / "ds" / "inbox" / "rec-busy").is_dir()
    assert store.latest_for("rec-busy") is not None and not store.is_deleted("rec-busy")


def test_latest_jobs_lists_each_recording_once_with_its_run_count(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    _finished_job(store, "rec-a", "complete")
    newest_a = _rerun(store, "rec-a", "complete")
    only_b = _finished_job(store, "rec-b", "error")
    rows = {job.recording_id: (job.job_id, runs) for job, runs in store.latest_jobs()}
    assert rows == {"rec-a": (newest_a.job_id, 2), "rec-b": (only_b.job_id, 1)}


# --- AI reviews ------------------------------------------------------------------


def test_database_from_before_ai_reviews_is_migrated(tmp_path: Path) -> None:
    """A jobs row written by the summarize/summaryStyle server opens with reviews filled in."""
    cfg = _cfg(tmp_path)
    Path(cfg.datastore).mkdir(parents=True)
    old = sqlite3.connect(str(Path(cfg.datastore) / "index.sqlite"))
    old.executescript(
        """
        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY, recording_id TEXT, status TEXT, error TEXT, title TEXT,
            summarize INTEGER, publish INTEGER, summary_style TEXT, writer TEXT, webdav_url TEXT,
            publish_folder TEXT, skip_asr INTEGER DEFAULT 0, only_publish INTEGER DEFAULT 0,
            created_at TEXT, updated_at TEXT, finished_at TEXT, asr_json TEXT, timings_json TEXT
        );
        """
    )
    folder = str(Path(cfg.webdav_folder) / "2025" / "09" / "20250920-1013-old")
    for job_id, summarize in (("j-sum", 1), ("j-txt", 0)):
        old.execute(
            "INSERT INTO jobs VALUES (?, ?, 'complete', NULL, 'Old', ?, 1, 'minutes', 'codex', "
            "'https://stale.test/x/summary.html', ?, 0, 0, '2025-09-20T10:13:00Z', "
            "'2025-09-20T10:20:00Z', '2025-09-20T10:20:00Z', NULL, NULL)",
            (job_id, f"rec-{job_id}", summarize, folder),
        )
    old.commit()
    old.close()

    store = JobStore(cfg)
    summarized, plain = store.job("j-sum"), store.job("j-txt")
    assert summarized is not None and summarized.reviews == ("summary",)
    assert plain is not None and plain.reviews == ()
    result = store.result_json("j-sum")
    assert result["reviews"] == ["summary"] and "summarize" not in result and "summaryStyle" not in result
    assert result["webdavUrl"] == "https://example.test/files/2025/09/20250920-1013-old/summary.html"
    assert store.result_json("j-txt")["webdavUrl"].endswith("/transcript.html")
    columns = {r[1] for r in store._conn.execute("PRAGMA table_info(jobs)")}
    assert {"summarize", "summary_style", "webdav_url"}.isdisjoint(columns)
    JobStore(cfg)  # opening a migrated database again is a no-op


def test_result_and_index_list_published_pages_in_page_order(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    rec = _finished_job(store, "rec-pages", "complete")
    assert store.result_json(rec.job_id)["pages"] == []
    folder = Path(rec.publish_folder)
    folder.mkdir(parents=True)
    for name in ("outline.html", "transcript.html", "summary.md"):
        (folder / name).write_text("x", encoding="utf-8")
    base = rec.webdav_url.rsplit("/", 1)[0]
    expected = [
        {"kind": "transcript", "url": f"{base}/transcript.html"},
        {"kind": "outline", "url": f"{base}/outline.html"},
    ]
    assert store.result_json(rec.job_id)["pages"] == expected
    (entry,) = store.recordings_index()
    assert entry.pages == expected


def test_retry_writer_reviews_default_to_the_job_and_can_be_replaced(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    rec = _finished_job(store, "rec-rr", "complete")
    (store.outbox_dir("rec-rr") / "transcript.txt").write_text("hello", encoding="utf-8")
    assert store.retry_writer(rec.job_id, None).reviews == ("summary",)
    store.set_status(rec.job_id, "complete")
    assert store.retry_writer(rec.job_id, None, ["organized", "outline"]).reviews == ("outline", "organized")
    store.set_status(rec.job_id, "complete")
    with pytest.raises(ValueError, match="at least one"):
        store.retry_writer(rec.job_id, None, [])
    with pytest.raises(ValueError, match="unknown review"):
        store.retry_writer(rec.job_id, None, ["poem"])


def test_add_review_queues_a_writer_only_job_that_follows_the_latest_publish(tmp_path: Path) -> None:
    store = JobStore(_cfg(tmp_path))
    first = _finished_job(store, "rec-add", "complete")  # publish=False in _valid_request
    with pytest.raises(StoreError, match="no transcript"):
        store.add_review("rec-add", "outline")
    (store.outbox_dir("rec-add") / "transcript.txt").write_text("hello", encoding="utf-8")
    with pytest.raises(ValueError, match="unknown review"):
        store.add_review("rec-add", "poem")

    added = store.add_review("rec-add", "outline")
    assert added.job_id != first.job_id and added.status == "queued"
    assert added.reviews == ("outline",) and added.skip_asr and not added.only_publish
    assert added.publish is False and added.publish_folder == first.publish_folder
    assert store.next_queued().job_id == added.job_id
    with pytest.raises(StoreError, match="still running"):
        store.add_review("rec-add", "summary")
    with pytest.raises(StoreError, match="unknown recording"):
        store.add_review("rec-none", "summary")


def test_restart_recovery_moves_on_every_job_the_previous_run_left_in_flight(tmp_path: Path) -> None:
    """A server stopped mid-job must not leave the recording answering job_active forever."""
    store = JobStore(_cfg(tmp_path))
    left = {}
    for rid, status, transcript in [
        ("rec-t", "transcribing", False),
        ("rec-w", "writing", True),
        ("rec-wx", "writing", False),  # no transcript on disk: it has to be made again
        ("rec-p", "publishing", True),
        ("rec-d", "published", True),
    ]:
        left[rid] = _finished_job(store, rid, status).job_id
        if transcript:
            store.outbox_dir(rid).mkdir(parents=True, exist_ok=True)
            (store.outbox_dir(rid) / "transcript.txt").write_text("words", encoding="utf-8")
    spec, data = _audio_spec(b"private-audio")
    private = store.create_job(_valid_request(spec, recording_id="rec-np", publish=False), {"id": "rec-np"})
    store.append_file(private.job_id, spec.name, 0, iter([data]))
    store.commit(private.job_id)
    store.set_status(private.job_id, "written")
    settled = {rid: _finished_job(store, rid, st).job_id for rid, st in [("rec-q", "queued"), ("rec-c", "complete"), ("rec-e", "error")]}

    moved = {job_id: (was, now) for job_id, was, now in store.recover_interrupted()}

    def state(job_id: str) -> tuple[str, bool, bool]:
        rec = store.job(job_id)
        return rec.status, rec.skip_asr, rec.only_publish

    assert state(left["rec-t"]) == ("queued", False, False)  # transcribe again
    assert state(left["rec-w"]) == ("queued", True, False)  # rewrite reviews from the transcript
    assert state(left["rec-wx"]) == ("queued", False, False)
    assert state(left["rec-p"]) == ("queued", True, True)  # publish only
    assert state(left["rec-d"])[0] == "complete"  # the last step had finished
    assert state(private.job_id)[0] == "complete"  # written and nothing to publish
    assert set(moved) == set(left.values()) | {private.job_id}
    assert moved[left["rec-p"]] == ("publishing", "queued")
    assert {rid: store.job(j).status for rid, j in settled.items()} == {"rec-q": "queued", "rec-c": "complete", "rec-e": "error"}
    assert any("recovered after a server restart: was writing" in line for line in store.read_log(left["rec-w"]))
    assert store.recover_interrupted() == []  # nothing left in flight
