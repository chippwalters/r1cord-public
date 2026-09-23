from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from r1cord_server.app import create_app
from r1cord_server.config import Config


AUDIO = b"0123456789"
AUDIO_SHA = hashlib.sha256(AUDIO).hexdigest()
CREATED_AT = 1_758_400_000_000


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("r1cord_server.worker.Worker.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.worker.Worker.stop", lambda self: None)
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
    body = r.json()
    assert body["serverName"] == "R1CORD"
    assert len(body["token"]) == 64
    return body["token"]


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _job_body(recording_id: str = "rec-api-1", sha: str = AUDIO_SHA, size: int = len(AUDIO)) -> dict:
    return {
        "job": {
            "schemaVersion": 1,
            "recordingId": recording_id,
            "createdAt": CREATED_AT,
            "title": "Site visit",
            "summarize": True,
            "publish": True,
            "summaryStyle": "notes",
            "files": [{"name": "audio.m4a", "size": size, "sha256": sha}],
        },
        "metadata": {"id": recording_id, "title": "Site visit", "createdAt": CREATED_AT},
    }


def test_401_without_bearer(client) -> None:
    c, _app = client
    r = c.get("/v1/recordings")
    assert r.status_code == 401
    body = r.json()
    assert body["error"] == "unauthorized"
    assert "message" in body


def test_pair_invalid_and_single_use(client) -> None:
    c, app = client
    r = c.post("/v1/pair", json={"code": "000000"})
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_code"

    code = app.state.store.create_pair_code()
    first = c.post("/v1/pair", json={"code": code})
    assert first.status_code == 200
    second = c.post("/v1/pair", json={"code": code})
    assert second.status_code == 400
    assert second.json()["error"] == "invalid_code"


def test_validation_error_shape(client) -> None:
    c, app = client
    token = _token(c, app)
    r = c.post("/v1/jobs", headers=_auth(token), json={})
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "invalid_request"
    assert "message" in body
    assert "detail" not in body


def test_upload_offset_resume_and_hash_mismatch(client) -> None:
    c, app = client
    token = _token(c, app)
    headers = _auth(token)
    created = c.post("/v1/jobs", headers=headers, json=_job_body())
    assert created.status_code == 202, created.text
    job_id = created.json()["jobId"]
    assert created.json()["status"] == "uploading"
    assert created.json()["webdavUrl"]
    assert created.json()["webdavUrl"].endswith("/summary.html")

    url = f"/v1/jobs/{job_id}/files/audio.m4a"
    head = c.get(url + "/received", headers=headers)
    assert head.status_code == 200
    assert head.json()["received"] == 0

    wrong = c.put(url, headers=headers, params={"offset": 3}, content=b"xxx")
    assert wrong.status_code == 409
    assert wrong.json()["error"] == "offset_mismatch"
    assert wrong.json()["received"] == 0

    part = c.put(url, headers=headers, params={"offset": 0}, content=AUDIO[:4])
    assert part.status_code == 200
    assert part.json()["received"] == 4
    head2 = c.get(url + "/received", headers=headers)
    assert head2.json()["received"] == 4

    rest = c.put(url, headers=headers, params={"offset": 4}, content=b"XXXXXX")
    assert rest.status_code == 200
    assert rest.json()["received"] == 10

    bad = c.post(f"/v1/jobs/{job_id}/commit", headers=headers)
    assert bad.status_code == 422
    assert bad.json()["error"] == "hash_mismatch"
    assert "audio.m4a" in bad.json()["files"]
    head3 = c.get(url + "/received", headers=headers)
    assert head3.json()["received"] == 0
    partial = app.state.store.inbox_dir("rec-api-1") / ".upload" / "audio.m4a.partial"
    assert not partial.exists()

    ok = c.put(url, headers=headers, params={"offset": 0}, content=AUDIO)
    assert ok.status_code == 200
    committed = c.post(f"/v1/jobs/{job_id}/commit", headers=headers)
    assert committed.status_code == 200
    assert committed.json()["status"] == "queued"

    again = c.post(f"/v1/jobs/{job_id}/commit", headers=headers)
    assert again.status_code == 200
    assert again.json()["status"] == "queued"

    got = c.get(f"/v1/jobs/{job_id}", headers=headers)
    assert got.status_code == 200
    assert got.json()["jobId"] == job_id
    assert got.json()["status"] == "queued"


def test_job_active_and_reuse_after_complete(client) -> None:
    c, app = client
    token = _token(c, app)
    headers = _auth(token)
    first = c.post("/v1/jobs", headers=headers, json=_job_body("rec-api-2"))
    assert first.status_code == 202
    job_id = first.json()["jobId"]

    clash = c.post("/v1/jobs", headers=headers, json=_job_body("rec-api-2"))
    assert clash.status_code == 409
    assert clash.json()["error"] == "job_active"
    assert clash.json()["jobId"] == job_id

    put = c.put(
        f"/v1/jobs/{job_id}/files/audio.m4a",
        headers=headers,
        params={"offset": 0},
        content=AUDIO,
    )
    assert put.status_code == 200
    assert c.post(f"/v1/jobs/{job_id}/commit", headers=headers).status_code == 200
    app.state.store.set_status(job_id, "complete")

    second = c.post("/v1/jobs", headers=headers, json=_job_body("rec-api-2"))
    assert second.status_code == 202
    job2 = second.json()["jobId"]
    assert job2 != job_id
    head = c.get(f"/v1/jobs/{job2}/files/audio.m4a/received", headers=headers)
    assert head.status_code == 200
    assert head.json()["received"] == len(AUDIO)

    committed = c.post(f"/v1/jobs/{job2}/commit", headers=headers)
    assert committed.status_code == 200
    assert committed.json()["status"] == "queued"

    listing = c.get("/v1/recordings", headers=headers)
    assert listing.status_code == 200
    rows = listing.json()
    assert any(row["recordingId"] == "rec-api-2" for row in rows)


def test_admin_open_on_loopback_but_basic_through_a_proxy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("r1cord_server.worker.Worker.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.worker.Worker.stop", lambda self: None)
    monkeypatch.setattr("r1cord_server.usb.UsbWatcher.start", lambda self: None)
    cfg = Config(datastore=tmp_path / "ds", webdav_folder=tmp_path / "wd", admin_password="test-admin-pass1")
    app = create_app(cfg)
    # The TestClient's default client address is not loopback: behaves like any remote caller.
    with TestClient(app) as remote:
        assert remote.get("/admin").status_code == 401
        assert remote.get("/admin", auth=("admin", "wrong")).status_code == 401
        assert remote.get("/admin", auth=("admin", "test-admin-pass1")).status_code == 200
    with TestClient(app, client=("127.0.0.1", 50000)) as local:
        assert local.get("/admin").status_code == 200
        # Same loopback socket, but the request came through cloudflared: password required.
        assert local.get("/admin", headers={"CF-Connecting-IP": "203.0.113.9"}).status_code == 401
        assert local.get("/admin", headers={"X-Forwarded-For": "203.0.113.9"}, auth=("admin", "test-admin-pass1")).status_code == 200
