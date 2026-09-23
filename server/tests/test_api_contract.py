"""Behavior tests for the /v1 wire contract (offload-api-v1.md): every route, every documented
status, the JSON error shape, Cache-Control, and the one-log-line-per-failure contract."""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from r1cord_server.app import create_app
from r1cord_server.config import Config

AUDIO = b"0123456789"
AUDIO_SHA = hashlib.sha256(AUDIO).hexdigest()
PHOTO = b"\xff\xd8photo"
PHOTO_SHA = hashlib.sha256(PHOTO).hexdigest()
CREATED_AT = 1_758_400_000_000

# (method, path) of every authenticated /v1 route; job ids never resolve — auth must refuse first.
AUTHED_ROUTES = [
    ("POST", "/v1/jobs"),
    ("GET", "/v1/jobs/j1/files/audio.m4a/received"),
    ("PUT", "/v1/jobs/j1/files/audio.m4a"),
    ("POST", "/v1/jobs/j1/commit"),
    ("GET", "/v1/jobs/j1"),
    ("GET", "/v1/recordings"),
    ("GET", "/v1/recordings/rec1"),
    ("POST", "/v1/jobs/j1/retry-writer"),
    ("POST", "/v1/jobs/j1/retry-publish"),
]


def _no_background_processes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("r1cord_server.worker.Worker.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.worker.Worker.stop", lambda self: None)
    monkeypatch.setattr("r1cord_server.usb.UsbWatcher.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.usb.UsbWatcher.stop", lambda self: None)


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _no_background_processes(monkeypatch)
    cfg = Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://example.test/files",
        admin_password="test-admin-pass1",
        server_name="R1CORD",
    )
    app = create_app(cfg)
    with TestClient(app) as c:
        yield c, app


def _token(client: TestClient, app) -> str:
    code = app.state.store.create_pair_code()
    r = client.post("/v1/pair", json={"code": code})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _job_body(
    recording_id: str = "rec-c1",
    sha: str = AUDIO_SHA,
    size: int = len(AUDIO),
    photo: bool = False,
    publish: bool = True,
    title: str = "Site visit",
) -> dict:
    files = [{"name": "audio.m4a", "size": size, "sha256": sha}]
    if photo:
        files.append({"name": "photo-abc123.jpg", "size": len(PHOTO), "sha256": PHOTO_SHA})
    return {
        "job": {
            "schemaVersion": 1,
            "recordingId": recording_id,
            "createdAt": CREATED_AT,
            "title": title,
            "summarize": True,
            "publish": publish,
            "summaryStyle": "notes",
            "files": files,
        },
        "metadata": {"id": recording_id, "title": title, "createdAt": CREATED_AT},
    }


def _create(client: TestClient, token: str, recording_id: str = "rec-c1", **kw) -> str:
    r = client.post("/v1/jobs", headers=_auth(token), json=_job_body(recording_id, **kw))
    assert r.status_code == 202, r.text
    return r.json()["jobId"]


def _put(client: TestClient, token: str, job_id: str, name: str, offset: int, content: bytes):
    r = client.put(
        f"/v1/jobs/{job_id}/files/{name}",
        headers=_auth(token),
        params={"offset": offset},
        content=content,
    )
    assert r.status_code == 200, r.text
    return r


def _received(client: TestClient, token: str, job_id: str, name: str) -> int:
    r = client.get(f"/v1/jobs/{job_id}/files/{name}/received", headers=_auth(token))
    assert r.status_code == 200, r.text
    return r.json()["received"]


def _commit(client: TestClient, token: str, job_id: str):
    r = client.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert r.status_code == 200, r.text
    return r


# --- pairing ---------------------------------------------------------------


def test_pair_roundtrip_accepts_code_with_whitespace(client) -> None:
    c, app = client
    code = app.state.store.create_pair_code()
    r = c.post("/v1/pair", json={"code": f"  {code} "})
    assert r.status_code == 200
    body = r.json()
    assert body["serverName"] == "R1CORD"
    assert len(body["token"]) == 64
    assert all(ch in "0123456789abcdef" for ch in body["token"])


def test_pair_expired_code_is_invalid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_background_processes(monkeypatch)
    cfg = Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        admin_password="test-admin-pass1",
        pair_code_ttl_s=-1,
    )
    app = create_app(cfg)
    with TestClient(app) as c:
        code = app.state.store.create_pair_code()
        r = c.post("/v1/pair", json={"code": code})
        assert r.status_code == 400
        body = r.json()
        assert body["error"] == "invalid_code"
        assert body["message"]


def test_pair_body_shape_errors_are_json(client) -> None:
    c, _app = client
    missing = c.post("/v1/pair", json={})
    assert missing.status_code == 422
    assert missing.json()["error"] == "invalid_request"
    assert "detail" not in missing.json()

    garbage = c.post(
        "/v1/pair", content=b"not json", headers={"content-type": "application/json"}
    )
    assert garbage.status_code == 422
    assert garbage.json()["error"] == "invalid_request"


# --- auth ------------------------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer"},
        {"Authorization": "Token abcdef"},
        {"Authorization": "Bearer not-a-real-token"},
    ],
    ids=["missing", "bare-scheme", "wrong-scheme", "unknown-token"],
)
def test_401_on_every_authenticated_route(client, headers) -> None:
    c, _app = client
    for method, path in AUTHED_ROUTES:
        kwargs: dict = {"headers": headers}
        if method == "POST" and path == "/v1/jobs":
            kwargs["json"] = _job_body()
        r = c.request(method, path, **kwargs)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}"
        body = r.json()
        assert body["error"] == "unauthorized"
        assert body["message"]
        assert r.headers["cache-control"] == "no-store"


def test_revoked_token_is_rejected(client) -> None:
    c, app = client
    token = _token(c, app)
    info = next(t for t in app.state.store.tokens() if not t.revoked)
    app.state.store.revoke_token(info.id)
    r = c.get("/v1/recordings", headers=_auth(token))
    assert r.status_code == 401
    assert r.json()["error"] == "unauthorized"


# --- POST /v1/jobs ---------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    [
        pytest.param(lambda b: b["job"].update(schemaVersion=2), id="schema-version"),
        pytest.param(lambda b: b["job"].update(recordingId="rec/1"), id="recording-id-slash"),
        pytest.param(lambda b: b["job"].update(recordingId=""), id="recording-id-empty"),
        pytest.param(lambda b: b["job"].update(recordingId=".."), id="recording-id-dotdot"),
        pytest.param(lambda b: b["job"].update(recordingId=" padded "), id="recording-id-padded"),
        pytest.param(lambda b: b["job"].update(summaryStyle="poem"), id="unknown-style"),
        pytest.param(lambda b: b["job"]["files"][0].update(sha256="nothex"), id="bad-sha256"),
        pytest.param(lambda b: b["job"]["files"][0].update(name="audio file.m4a"), id="name-space"),
        pytest.param(lambda b: b["job"]["files"][0].update(name="notes.txt"), id="name-unlisted"),
        pytest.param(lambda b: b["job"]["files"][0].update(name="photo.png"), id="photo-extension"),
        pytest.param(lambda b: b["job"].update(files=[]), id="empty-files"),
        pytest.param(
            lambda b: b["job"].update(
                files=[{"name": "photo-x.jpg", "size": 1, "sha256": AUDIO_SHA}]
            ),
            id="no-audio",
        ),
        pytest.param(
            lambda b: b["job"]["files"].append(
                {"name": "audio.wav", "size": 1, "sha256": AUDIO_SHA}
            ),
            id="two-audios",
        ),
        pytest.param(
            lambda b: b["job"]["files"].append(
                {"name": "audio.m4a", "size": 1, "sha256": AUDIO_SHA}
            ),
            id="duplicate-name",
        ),
        pytest.param(lambda b: b["job"]["files"][0].update(size=-1), id="negative-size"),
        pytest.param(lambda b: b["job"].update(title="   "), id="title-blank"),
        pytest.param(lambda b: b["job"].update(title="x" * 121), id="title-too-long"),
    ],
)
def test_create_job_rejects_each_invalid_manifest(client, case) -> None:
    c, app = client
    token = _token(c, app)
    body = _job_body()
    case(body)
    r = c.post("/v1/jobs", headers=_auth(token), json=body)
    assert r.status_code == 422
    payload = r.json()
    assert payload["error"] == "invalid_request"
    assert payload["message"]


def test_create_job_response_and_publish_flag(client) -> None:
    c, app = client
    token = _token(c, app)
    pub = c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-pub", title="x" * 120))
    assert pub.status_code == 202, pub.text
    body = pub.json()
    assert body["recordingId"] == "rec-pub"
    assert body["status"] == "uploading"
    assert body["webdavUrl"].startswith("https://example.test/files/")
    assert body["webdavUrl"].endswith("/summary.html")

    r2 = c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-priv", publish=False))
    assert r2.status_code == 202
    assert r2.json()["webdavUrl"] is None


def test_job_active_conflict_names_the_active_job(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-active")
    clash = c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-active"))
    assert clash.status_code == 409
    body = clash.json()
    assert body["error"] == "job_active"
    assert body["jobId"] == job_id


def test_audio_mismatch_after_committed_audio(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-mm")
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, job_id)
    app.state.store.set_status(job_id, "complete")

    other_sha = hashlib.sha256(b"a different recording").hexdigest()
    r = c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-mm", sha=other_sha))
    assert r.status_code == 409
    assert r.json()["error"] == "audio_mismatch"


# --- received / PUT --------------------------------------------------------


def test_received_progress_and_404s(client) -> None:
    c, app = client
    token = _token(c, app)
    unknown = c.get("/v1/jobs/nope/files/audio.m4a/received", headers=_auth(token))
    assert unknown.status_code == 404
    assert unknown.json()["error"] == "not_found"

    job_id = _create(c, token, "rec-rx", photo=True)
    bad_name = c.get(f"/v1/jobs/{job_id}/files/photo-missing.jpg/received", headers=_auth(token))
    assert bad_name.status_code == 404
    assert "not in the job manifest" in bad_name.json()["message"]

    assert _received(c, token, job_id, "audio.m4a") == 0
    assert _received(c, token, job_id, "photo-abc123.jpg") == 0
    _put(c, token, job_id, "audio.m4a", 0, AUDIO[:4])
    assert _received(c, token, job_id, "audio.m4a") == 4
    assert _received(c, token, job_id, "photo-abc123.jpg") == 0


def test_put_offset_rules(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-off")
    url = f"/v1/jobs/{job_id}/files/audio.m4a"

    wrong = c.put(url, headers=_auth(token), params={"offset": 5}, content=AUDIO[:4])
    assert wrong.status_code == 409
    body = wrong.json()
    assert body["error"] == "offset_mismatch"
    assert body["received"] == 0

    negative = c.put(url, headers=_auth(token), params={"offset": -1}, content=AUDIO[:4])
    assert negative.status_code == 409
    assert negative.json()["error"] == "offset_mismatch"
    assert negative.json()["received"] == 0

    # offset omitted defaults to 0 (documented): a fresh file accepts the bytes.
    implicit = c.put(url, headers=_auth(token), content=AUDIO[:4])
    assert implicit.status_code == 200
    assert implicit.json()["received"] == 4

    resume = c.put(url, headers=_auth(token), params={"offset": 4}, content=AUDIO[4:])
    assert resume.status_code == 200
    assert resume.json()["received"] == len(AUDIO)

    not_a_number = c.put(url, headers=_auth(token), params={"offset": "abc"}, content=b"x")
    assert not_a_number.status_code == 422
    assert not_a_number.json()["error"] == "invalid_request"


def test_put_too_large_keeps_resume_point(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-413")
    url = f"/v1/jobs/{job_id}/files/audio.m4a"

    _put(c, token, job_id, "audio.m4a", 0, AUDIO[:4])
    burst = c.put(url, headers=_auth(token), params={"offset": 4}, content=b"W" * 7)
    assert burst.status_code == 413
    assert burst.json()["error"] == "too_large"
    # The rejected burst was rolled back to the resume point, not appended.
    assert _received(c, token, job_id, "audio.m4a") == 4

    finish = c.put(url, headers=_auth(token), params={"offset": 4}, content=AUDIO[4:])
    assert finish.status_code == 200
    assert finish.json()["received"] == len(AUDIO)

    extra = c.put(url, headers=_auth(token), params={"offset": 10}, content=b"x")
    assert extra.status_code == 413
    # An empty re-PUT at the full length is an idempotent no-op.
    noop = c.put(url, headers=_auth(token), params={"offset": 10}, content=b"")
    assert noop.status_code == 200
    assert noop.json()["received"] == len(AUDIO)


def test_put_unknown_job_and_unknown_file(client) -> None:
    c, app = client
    token = _token(c, app)
    unknown = c.put(
        "/v1/jobs/nope/files/audio.m4a", headers=_auth(token), params={"offset": 0}, content=b"x"
    )
    assert unknown.status_code == 404
    assert unknown.json()["error"] == "not_found"

    job_id = _create(c, token, "rec-404")
    not_listed = c.put(
        f"/v1/jobs/{job_id}/files/photo-abc123.jpg",
        headers=_auth(token),
        params={"offset": 0},
        content=b"x",
    )
    assert not_listed.status_code == 404
    assert "not in the job manifest" in not_listed.json()["message"]


def test_put_after_commit_is_refused(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-late")
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, job_id)
    late = c.put(
        f"/v1/jobs/{job_id}/files/audio.m4a",
        headers=_auth(token),
        params={"offset": 0},
        content=b"x",
    )
    assert late.status_code == 409
    assert late.json()["error"] == "job_not_uploading"


# --- commit ----------------------------------------------------------------


def test_commit_incomplete_lists_every_file(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-inc", photo=True)
    _put(c, token, job_id, "photo-abc123.jpg", 0, PHOTO[:4])
    r = c.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "incomplete"
    assert body["files"] == [
        {"name": "audio.m4a", "received": 0, "size": len(AUDIO)},
        {"name": "photo-abc123.jpg", "received": 4, "size": len(PHOTO)},
    ]

    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _put(c, token, job_id, "photo-abc123.jpg", 4, PHOTO[4:])
    _commit(c, token, job_id)


def test_commit_hash_mismatch_deletes_only_offending_partial(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-hash", photo=True)
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _put(c, token, job_id, "photo-abc123.jpg", 0, b"W" * len(PHOTO))

    r = c.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "hash_mismatch"
    assert body["files"] == ["photo-abc123.jpg"]

    # The good audio partial survived; the bad photo restarts from 0.
    assert _received(c, token, job_id, "audio.m4a") == len(AUDIO)
    assert _received(c, token, job_id, "photo-abc123.jpg") == 0
    partial = app.state.store.inbox_dir("rec-hash") / ".upload" / "photo-abc123.jpg.partial"
    assert not partial.exists()

    _put(c, token, job_id, "photo-abc123.jpg", 0, PHOTO)
    _commit(c, token, job_id)


def test_commit_idempotent_and_get_job_schema(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-ok")
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    first = c.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert first.status_code == 200
    assert first.json()["jobId"] == job_id
    assert first.json()["status"] == "queued"
    assert first.json()["webdavUrl"].endswith("/summary.html")

    again = c.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert again.status_code == 200
    assert again.json()["status"] == "queued"

    got = c.get(f"/v1/jobs/{job_id}", headers=_auth(token))
    assert got.status_code == 200
    result = got.json()
    assert result["schemaVersion"] == 1
    assert result["jobId"] == job_id
    assert result["recordingId"] == "rec-ok"
    assert result["status"] == "queued"
    assert result["title"] == "Site visit"
    assert result["webdavUrl"].endswith("/summary.html")
    assert isinstance(result["history"], list) and result["history"]

    unknown = c.get("/v1/jobs/nope", headers=_auth(token))
    assert unknown.status_code == 404
    assert unknown.json()["error"] == "not_found"


def test_get_job_hides_webdav_url_when_not_publishing(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-quiet", publish=False)
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, job_id)
    result = c.get(f"/v1/jobs/{job_id}", headers=_auth(token)).json()
    assert result["publish"] is False
    assert result["webdavUrl"] is None


# --- recordings ------------------------------------------------------------


def test_recordings_listing_latest_per_recording_newest_first(client, monkeypatch) -> None:
    c, app = client
    token = _token(c, app)

    # A deterministic, strictly increasing clock keeps updated_at ordering stable.
    base = datetime.now(timezone.utc) + timedelta(hours=1)
    ticks = {"n": 0}

    def fake_now() -> str:
        ticks["n"] += 1
        return (base + timedelta(seconds=ticks["n"])).isoformat().replace("+00:00", "Z")

    monkeypatch.setattr("r1cord_server.store.utcnow_iso", fake_now)

    old_id = _create(c, token, "rec-old")
    _put(c, token, old_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, old_id)
    new_id = _create(c, token, "rec-new", publish=False)
    _put(c, token, new_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, new_id)

    rows = c.get("/v1/recordings", headers=_auth(token)).json()
    assert [row["recordingId"] for row in rows][:2] == ["rec-new", "rec-old"]
    by_id = {row["recordingId"]: row for row in rows}
    assert by_id["rec-old"]["jobId"] == old_id
    assert by_id["rec-old"]["status"] == "queued"
    assert by_id["rec-old"]["webdavUrl"].endswith("/summary.html")
    assert by_id["rec-new"]["webdavUrl"] is None  # publish=false hides the predicted URL
    assert all(set(r) == {"recordingId", "jobId", "status", "webdavUrl", "updatedAt"} for r in rows)


def test_get_recording_returns_latest_job(client) -> None:
    c, app = client
    token = _token(c, app)
    job1 = _create(c, token, "rec-latest")
    _put(c, token, job1, "audio.m4a", 0, AUDIO)
    _commit(c, token, job1)
    app.state.store.set_status(job1, "complete")

    job2 = _create(c, token, "rec-latest")
    result = c.get("/v1/recordings/rec-latest", headers=_auth(token))
    assert result.status_code == 200
    body = result.json()
    assert body["jobId"] == job2
    assert body["status"] == "uploading"
    assert [h["jobId"] for h in body["history"]] == [job1, job2]

    none = c.get("/v1/recordings/never-seen", headers=_auth(token))
    assert none.status_code == 404
    assert none.json()["error"] == "not_found"


# --- retries ---------------------------------------------------------------


def test_retry_writer_input_validation(client) -> None:
    c, app = client
    token = _token(c, app)

    unknown = c.post("/v1/jobs/nope/retry-writer", headers=_auth(token))
    assert unknown.status_code == 404

    job_id = _create(c, token, "rec-rw")
    malformed = c.post(
        f"/v1/jobs/{job_id}/retry-writer",
        headers={**_auth(token), "content-type": "application/json"},
        content=b"{not json",
    )
    assert malformed.status_code == 422
    assert malformed.json()["error"] == "invalid_request"

    bad_writer = c.post(
        f"/v1/jobs/{job_id}/retry-writer", headers=_auth(token), json={"writer": "gpt9"}
    )
    assert bad_writer.status_code == 422
    assert bad_writer.json()["error"] == "invalid_request"


def test_retry_writer_allowed_and_refused_states(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-rw2")

    while_uploading = c.post(f"/v1/jobs/{job_id}/retry-writer", headers=_auth(token))
    assert while_uploading.status_code == 409
    assert while_uploading.json()["error"] == "retry_not_allowed"

    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, job_id)
    while_queued = c.post(f"/v1/jobs/{job_id}/retry-writer", headers=_auth(token))
    assert while_queued.status_code == 409
    assert while_queued.json()["error"] == "retry_not_allowed"

    app.state.store.set_status(job_id, "error", error="writer: boom")
    no_transcript = c.post(f"/v1/jobs/{job_id}/retry-writer", headers=_auth(token))
    assert no_transcript.status_code == 409
    assert no_transcript.json()["error"] == "retry_not_allowed"
    assert "transcript" in no_transcript.json()["message"]

    (app.state.store.outbox_dir("rec-rw2") / "transcript.txt").write_text(
        "hello transcript", encoding="utf-8"
    )
    ok = c.post(f"/v1/jobs/{job_id}/retry-writer", headers=_auth(token), json={"writer": "codex"})
    assert ok.status_code == 200
    assert ok.json()["status"] == "queued"
    rec = app.state.store.job(job_id)
    assert rec is not None
    assert rec.writer == "codex"
    assert rec.skip_asr is True


def test_retry_publish_allowed_and_refused(client) -> None:
    c, app = client
    token = _token(c, app)

    unknown = c.post("/v1/jobs/nope/retry-publish", headers=_auth(token))
    assert unknown.status_code == 404

    job_id = _create(c, token, "rec-rp")
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)
    _commit(c, token, job_id)

    no_summary = c.post(f"/v1/jobs/{job_id}/retry-publish", headers=_auth(token))
    assert no_summary.status_code == 409
    assert no_summary.json()["error"] == "retry_not_allowed"
    assert "summary" in no_summary.json()["message"]

    (app.state.store.outbox_dir("rec-rp") / "summary.md").write_text(
        "# Summary", encoding="utf-8"
    )
    ok = c.post(f"/v1/jobs/{job_id}/retry-publish", headers=_auth(token))
    assert ok.status_code == 200
    assert ok.json()["status"] == "queued"
    rec = app.state.store.job(job_id)
    assert rec is not None
    assert rec.only_publish is True
    assert rec.skip_asr is True


# --- cross-cutting: error shape, caching, logging ---------------------------


def test_unknown_route_and_method_stay_json(client) -> None:
    c, _app = client
    no_route = c.get("/v1/nope")
    assert no_route.status_code == 404
    assert no_route.json()["error"] == "not_found"
    assert no_route.json()["message"]

    wrong_method = c.delete("/v1/recordings")
    assert wrong_method.status_code == 405
    body = wrong_method.json()
    assert body["error"] == "http_error"
    assert body["message"]


def test_every_response_carries_cache_control_no_store(client) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-cc")
    checks = [
        c.post("/v1/pair", json={"code": "000000"}),  # 400
        c.get("/v1/recordings"),  # 401
        c.get("/v1/jobs/nope", headers=_auth(token)),  # 404
        c.put(
            f"/v1/jobs/{job_id}/files/audio.m4a",
            headers=_auth(token),
            params={"offset": 9},
            content=b"x",
        ),  # 409
        c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-cc2", sha="bad")),  # 422
        c.get(f"/v1/jobs/{job_id}", headers=_auth(token)),  # 200
    ]
    for r in checks:
        assert r.headers["cache-control"] == "no-store", f"{r.request.method} {r.request.url}"


def test_422_logs_machine_code_and_route(client, caplog) -> None:
    c, app = client
    token = _token(c, app)
    body = _job_body("rec-log")
    body["job"]["summaryStyle"] = "haiku"
    with caplog.at_level(logging.INFO, logger="r1cord_server.api"):
        r = c.post("/v1/jobs", headers=_auth(token), json=body)
    assert r.status_code == 422
    hits = [rec for rec in caplog.records if "invalid_request" in rec.getMessage()]
    assert hits, "expected a log line carrying the machine code"
    rec = hits[-1]
    assert rec.levelno == logging.WARNING
    assert "POST /v1/jobs" in rec.getMessage()
    assert "422" in rec.getMessage()


def test_409_job_active_logs_active_job_id(client, caplog) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-clash")
    with caplog.at_level(logging.INFO, logger="r1cord_server.api"):
        r = c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-clash"))
    assert r.status_code == 409
    hits = [rec for rec in caplog.records if "job_active" in rec.getMessage()]
    assert hits
    rec = hits[-1]
    assert rec.levelno == logging.INFO  # expected client race, not a server fault
    assert job_id in rec.getMessage()
    assert "409" in rec.getMessage()


def test_unexpected_failure_answers_json_500_and_logs_once(client, monkeypatch, caplog) -> None:
    c, app = client
    token = _token(c, app)
    job_id = _create(c, token, "rec-boom")
    _put(c, token, job_id, "audio.m4a", 0, AUDIO)

    def explode(job_id_arg: str):
        raise RuntimeError("disk exploded")

    monkeypatch.setattr(app.state.store, "commit", explode)
    with caplog.at_level(logging.INFO, logger="r1cord_server.api"):
        r = c.post(f"/v1/jobs/{job_id}/commit", headers=_auth(token))
    assert r.status_code == 500
    body = r.json()
    assert body["error"] == "internal_error"
    assert body["message"]

    hits = [rec for rec in caplog.records if "internal_error" in rec.getMessage()]
    assert len(hits) == 1  # one line, not one per stack frame
    message = hits[0].getMessage()
    assert "POST /v1/jobs" in message and "/commit" in message
    assert "500" in message
    assert "RuntimeError: disk exploded" in message
    assert token not in message


def test_tokens_are_never_logged(client, caplog) -> None:
    c, app = client
    with caplog.at_level(logging.INFO, logger="r1cord_server"):
        # A spread of failures, authenticated and not; none may leak the bearer token.
        c.get("/v1/recordings")
        c.get("/v1/recordings", headers={"Authorization": "Bearer bogus-token-value"})
        token = _token(c, app)
        c.get("/v1/jobs/nope", headers=_auth(token))
        c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-sec"))
        c.post("/v1/jobs", headers=_auth(token), json=_job_body("rec-sec"))
        c.post("/v1/pair", json={"code": "000000"})

    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert token not in logged
    assert "Bearer" not in logged
    assert any("401 unauthorized" in line for line in logged.splitlines())
