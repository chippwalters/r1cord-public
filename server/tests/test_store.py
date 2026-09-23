from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from r1cord_server.config import Config
from r1cord_server.store import (
    AudioMismatch,
    FileSpec,
    HashMismatch,
    Incomplete,
    JobActive,
    JobRequest,
    JobStore,
    OffsetMismatch,
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
        summarize=True,
        publish=True,
        summary_style="notes",
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
    rec = store.import_folder(src, title=None, summarize=True, publish=False, style="notes")
    assert rec.recording_id == "rec-drop"
    assert rec.status == "queued"
    assert rec.title == "Dropped"
    assert rec.publish is False
    assert (store.inbox_dir("rec-drop") / "audio.wav").is_file()
