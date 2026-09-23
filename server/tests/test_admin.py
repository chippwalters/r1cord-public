"""Behavior tests for the local admin UI: dashboard, job, devices, config, import, files."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import replace
from types import SimpleNamespace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from r1cord_server import admin as admin_module
from r1cord_server import mailer as mailer_module
from r1cord_server.app import create_app
from r1cord_server.config import Config, load as load_config
from r1cord_server.mailer import MailError

BASIC = ("admin", "test-admin-pass1")
TUNNEL = {"CF-Connecting-IP": "203.0.113.9"}

RESTART_NOTE = '<p class="warn">Listen host/port changes take effect on restart.</p>'


class FakeUsb:
    """The two things admin routes touch on UsbWatcher: status() and poll_now()."""

    def __init__(self) -> None:
        self.connected: list[tuple[str, str, bool]] = []
        self.polls = 0

    def status(self) -> object:
        return SimpleNamespace(
            enabled=True, adb="fake-adb", connected=list(self.connected), syncing=None, last_error=None
        )

    def poll_now(self) -> None:
        self.polls += 1


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("r1cord_server.worker.Worker.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.worker.Worker.stop", lambda self: None)
    monkeypatch.setattr("r1cord_server.usb.UsbWatcher.start", lambda self: None)
    monkeypatch.setattr("r1cord_server.usb.UsbWatcher.stop", lambda self: None)
    # Health panel helpers that would touch the GPU runtime or the MD DOCS loopback bridge.
    monkeypatch.setattr(admin_module, "_gpu_status", lambda: "no (test)")
    monkeypatch.setattr(admin_module, "_mddocs_status", lambda: ("unavailable", "unavailable"))
    cfg = Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://example.test/files",
        admin_password="test-admin-pass1",
        server_name="R1CORD",
    )
    config_path = tmp_path / "config.toml"
    app = create_app(cfg, config_path=config_path)
    usb = FakeUsb()
    app.state.usb = usb
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        yield SimpleNamespace(
            client=client, app=app, store=app.state.store, usb=usb, tmp=tmp_path, config_path=config_path
        )


def _make_recording(env, recording_id: str, *, title: str = "Site visit", audio: bytes = b"0123456789abcdef"):
    """Import a source folder through the store: leaves a queued job and the audio in inbox/."""
    folder = env.tmp / "src" / recording_id
    folder.mkdir(parents=True)
    (folder / "audio.wav").write_bytes(audio)
    (folder / "metadata.json").write_text(
        json.dumps({"id": recording_id, "title": title, "createdAt": 1_758_400_000_000}), encoding="utf-8"
    )
    return env.store.import_folder(folder, title=title, summarize=True, publish=False, style="notes")


def _make_inbox_recording(env, recording_id: str, *, audio: bytes = b"0123456789abcdef") -> None:
    """A recording sitting in inbox/ but not yet queued (the USB pull case)."""
    folder = env.store.inbox_dir(recording_id)
    (folder / "audio.wav").write_bytes(audio)
    (folder / "metadata.json").write_text(
        json.dumps({"id": recording_id, "title": "USB take", "createdAt": 1_758_400_000_000}), encoding="utf-8"
    )
def test_proxy_headers_alone_force_a_challenge_on_every_admin_route(env) -> None:
    c = env.client
    routes = [
        ("get", "/admin", None),
        ("get", "/admin/devices", None),
        ("get", "/admin/jobs/j1", None),
        ("get", "/admin/config", None),
        ("get", "/admin/import", None),
        ("get", "/admin/files/r/summary.md", None),
        ("get", "/admin/recordings/r/audio", None),
        ("post", "/admin/usb/toggle", None),
        ("post", "/admin/usb/poll", None),
        ("post", "/admin/pair", None),
        ("post", "/admin/jobs/j1/email", None),
        ("post", "/admin/jobs/j1/retry-writer", {"writer": ""}),
        ("post", "/admin/jobs/j1/retry-publish", None),
        ("post", "/admin/tokens/999/revoke", None),
        ("post", "/admin/config", {"server_name": "R1CORD"}),
        ("post", "/admin/import", {"folder": "Z:/nope"}),
        ("post", "/admin/recordings/r/folder", None),
        ("post", "/admin/devices/S1/adopt", None),
        ("post", "/admin/devices/S1/forget", None),
        ("post", "/admin/devices/S1/recordings/r/process", {"action": "summarize"}),
    ]
    for method, path, form in routes:
        kwargs = {"data": form} if method == "post" else {}
        r = getattr(c, method)(path, headers=TUNNEL, follow_redirects=False, **kwargs)
        assert r.status_code == 401, (method, path, r.status_code)
        assert r.json() == {"error": "unauthorized", "message": "invalid admin credentials"}, (method, path)
    # And each of the three proxy headers is enough on its own.
    for header in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
        r = c.get("/admin", headers={header: "203.0.113.9"})
        assert r.status_code == 401, header
        assert r.headers["www-authenticate"] == 'Basic realm="r1cord-admin"'
    assert c.get("/admin").status_code == 200  # loopback without a proxy header needs no login


def test_admin_routes_answer_once_authenticated_through_the_tunnel(env) -> None:
    c = env.client
    expectations = [
        (("get", "/admin"), None, 200),
        (("get", "/admin/devices"), None, 200),
        (("get", "/admin/jobs/ghost"), None, 200),  # unknown-job page is still a page
        (("get", "/admin/config"), None, 200),
        (("get", "/admin/import"), None, 200),
        (("get", "/admin/files/r/summary.md"), None, 404),  # valid id, missing file
        (("get", "/admin/recordings/r/audio"), None, 404),
        (("post", "/admin/jobs/ghost/email"), None, 303),  # notice redirect
        (("post", "/admin/jobs/ghost/retry-writer"), {"writer": ""}, 303),
        (("post", "/admin/jobs/ghost/retry-publish"), None, 303),
        (("post", "/admin/tokens/999/revoke"), None, 303),
        (("post", "/admin/config"), None, 200),
        (("post", "/admin/import"), {"folder": "Z:/nope"}, 200),  # error re-render
        (("post", "/admin/recordings/r/folder"), None, 403),
        (("post", "/admin/devices/S1/adopt"), None, 303),
        (("post", "/admin/devices/S1/forget"), None, 303),
        (("post", "/admin/devices/S1/recordings/r/process"), {"action": "summarize"}, 303),
    ]
    for (method, path), form, expected in expectations:
        kwargs = {"data": form} if method == "post" else {}
        r = getattr(c, method)(path, headers=TUNNEL, auth=BASIC, follow_redirects=False, **kwargs)
        assert r.status_code == expected, (method, path, r.status_code)


# --- Dashboard ---------------------------------------------------------------------------------


def test_dashboard_recordings_play_in_the_page_and_keep_show_in_folder_local(env) -> None:
    with_audio = _make_recording(env, "rec-dash-1", audio=b"A" * 2049)  # 2.0 KB
    _make_recording(env, "rec-dash-2")
    # A recording whose audio vanished from the inbox shows an em dash and no audio actions.
    (Path(env.store.config.datastore) / "inbox" / "rec-dash-2" / "audio.wav").unlink()
    c = env.client

    local = c.get("/admin").text
    assert with_audio.job_id in local and "rec-dash-1" in local
    assert "2.0 KB" in local
    assert 'data-play="/admin/recordings/rec-dash-1/audio"' in local
    assert 'action="/admin/recordings/rec-dash-1/folder"' in local
    assert 'href="/admin/recordings/rec-dash-1/audio"' in local
    assert "rec-dash-2/audio" not in local and "rec-dash-2/folder" not in local

    # The same page through the tunnel: play and download yes, the desktop action no.
    tunnel = c.get("/admin", headers=TUNNEL, auth=BASIC).text
    assert 'data-play="/admin/recordings/rec-dash-1/audio"' in tunnel
    assert 'href="/admin/recordings/rec-dash-1/audio"' in tunnel
    assert "/folder" not in tunnel


# --- Job page ----------------------------------------------------------------------------------


def test_job_page_unknown_job_notice_sent_and_email_button(env) -> None:
    c = env.client
    unknown = c.get("/admin/jobs/nope").text
    assert "Unknown job" in unknown and "nope" in unknown

    rec = _make_recording(env, "rec-job-1")
    page = c.get(f"/admin/jobs/{rec.job_id}").text
    assert "Site visit" in page
    assert f'action="/admin/jobs/{rec.job_id}/email"' in page
    assert 'type="submit" disabled' in page  # no email_to configured
    assert "Set email_to on the" in page

    env.app.state.config = replace(env.app.state.config, email_to="me@example.test")
    page = c.get(f"/admin/jobs/{rec.job_id}").text
    assert 'type="submit" disabled' not in page
    assert "to me@example.test" in page

    assert '<p class="error">Boom</p>' in c.get(f"/admin/jobs/{rec.job_id}?notice=Boom").text
    assert "Emailed to a@b.c." in c.get(f"/admin/jobs/{rec.job_id}?sent=a%40b.c").text


def test_job_page_lists_outbox_files(env) -> None:
    rec = _make_recording(env, "rec-files-page")
    outbox = env.store.outbox_dir("rec-files-page")
    (outbox / "summary.md").write_text("# s", encoding="utf-8")
    (outbox / "photos").mkdir()
    (outbox / "photos" / "photo-1.jpg").write_bytes(b"jpg")
    page = env.client.get(f"/admin/jobs/{rec.job_id}").text
    assert 'href="/admin/files/rec-files-page/summary.md"' in page
    assert 'href="/admin/files/rec-files-page/photos/photo-1.jpg"' in page


def test_admin_email_job_success_and_failure(
    env, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="r1cord_server.admin")
    rec = _make_recording(env, "rec-mail-1")
    (env.store.outbox_dir("rec-mail-1") / "summary.md").write_text("# Done", encoding="utf-8")
    env.app.state.config = replace(env.app.state.config, email_to="me@example.test")
    c = env.client

    sent: list[object] = []

    def fake_send(_cfg, msg, **_kw):
        sent.append(msg)
        return "stub-id"

    monkeypatch.setattr(mailer_module, "send", fake_send)
    r = c.post(f"/admin/jobs/{rec.job_id}/email", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == f"/admin/jobs/{rec.job_id}?sent=me%40example.test"
    assert str(sent[0]["Subject"]) == "Site visit"
    assert any("email: sent to me@example.test (stub-id)" in line for line in env.store.read_log(rec.job_id))

    def refuse(_cfg, _msg, **_kw):
        raise MailError("gws: Insufficient Permission")

    monkeypatch.setattr(mailer_module, "send", refuse)
    r = c.post(f"/admin/jobs/{rec.job_id}/email", follow_redirects=False)
    assert r.status_code == 303
    assert "notice=" in r.headers["location"]
    assert "Email: gws: Insufficient Permission" in c.get(r.headers["location"]).text
    warnings = [
        rec_line
        for rec_line in caplog.records
        if rec_line.name == "r1cord_server.admin"
        and rec_line.levelno == logging.WARNING
        and rec.job_id in rec_line.getMessage()
    ]
    assert len(warnings) == 1  # logged once, with the job id, never more


def test_admin_email_unknown_job_still_shows_the_error(env) -> None:
    env.app.state.config = replace(env.app.state.config, email_to="me@example.test")
    r = env.client.post("/admin/jobs/ghost/email", follow_redirects=False)
    assert r.status_code == 303
    page = env.client.get(r.headers["location"]).text
    assert "Unknown job" in page
    assert "Email: unknown job ghost" in page  # the notice must survive on the unknown-job page


def test_admin_email_with_nothing_to_send_shows_a_notice(env) -> None:
    env.app.state.config = replace(env.app.state.config, email_to="me@example.test")
    rec = _make_recording(env, "rec-mail-empty")  # queued, outbox empty
    r = env.client.post(f"/admin/jobs/{rec.job_id}/email", follow_redirects=False)
    assert "notice=" in r.headers["location"]
    page = env.client.get(r.headers["location"]).text
    assert "Email: nothing to email: no summary or transcript yet" in page


# --- Retry forms ---------------------------------------------------------------------------------


def test_retry_writer_form_rules(env) -> None:
    rec = _make_recording(env, "rec-retry-1")
    c = env.client
    r = c.post(f"/admin/jobs/{rec.job_id}/retry-writer", data={"writer": ""}, follow_redirects=False)
    assert r.status_code == 303 and "notice=" in r.headers["location"]
    assert "cannot retry writer from status queued" in c.get(r.headers["location"]).text

    env.store.set_status(rec.job_id, "error", error="writer: boom")
    (env.store.outbox_dir("rec-retry-1") / "transcript.txt").write_text("words", encoding="utf-8")
    r = c.post(f"/admin/jobs/{rec.job_id}/retry-writer", data={"writer": ""}, follow_redirects=False)
    assert r.status_code == 303 and "notice=" not in r.headers["location"]
    assert env.store.job(rec.job_id).status == "queued"
    assert env.store.job(rec.job_id).error is None

    env.store.set_status(rec.job_id, "error", error="again")
    r = c.post(f"/admin/jobs/{rec.job_id}/retry-writer", data={"writer": "codex"}, follow_redirects=False)
    assert r.status_code == 303 and "notice=" not in r.headers["location"]
    assert env.store.job(rec.job_id).writer == "codex"


def test_retry_publish_form_rules(env) -> None:
    rec = _make_recording(env, "rec-retry-2")
    c = env.client
    r = c.post(f"/admin/jobs/{rec.job_id}/retry-publish", follow_redirects=False)
    assert r.status_code == 303 and "notice=" in r.headers["location"]
    assert "summary.md is missing" in c.get(r.headers["location"]).text

    (env.store.outbox_dir("rec-retry-2") / "summary.md").write_text("# s", encoding="utf-8")
    r = c.post(f"/admin/jobs/{rec.job_id}/retry-publish", follow_redirects=False)
    assert r.status_code == 303 and "notice=" not in r.headers["location"]
    assert env.store.job(rec.job_id).status == "queued"


# --- Files (outbox downloads) ---------------------------------------------------------------------


def test_files_route_serves_only_files_inside_that_recordings_outbox(env) -> None:
    _make_recording(env, "rec-files-1")
    inbox_audio = Path(env.store.config.datastore) / "inbox" / "rec-files-1" / "audio.wav"
    outbox = env.store.outbox_dir("rec-files-1")
    (outbox / "summary.md").write_text("# hi", encoding="utf-8")
    c = env.client

    assert c.get("/admin/files/rec-files-1/summary.md").text == "# hi"
    assert c.get("/admin/files/rec-files-1/missing.md").status_code == 404

    # A name that escapes the outbox...
    assert c.get("/admin/files/rec-files-1/%2E%2E/inbox/rec-files-1/audio.wav").status_code == 400
    # ...or is absolute on this machine...
    assert c.get("/admin/files/rec-files-1/C:%5CWindows%5Cwin.ini").status_code == 400
    # ...and a recording id that resolves outside outbox/ altogether (regression: used to serve
    # the inbox audio with a 200).
    r = c.get("/admin/files/%2E%2E/inbox/rec-files-1/audio.wav")
    assert r.status_code == 400
    assert r.text == "invalid path"
    assert inbox_audio.is_file()  # untouched


# --- Recordings edges ------------------------------------------------------------------------------


def test_recording_audio_wav_no_audio_and_dotted_ids(env) -> None:
    c = env.client
    _make_recording(env, "rec.wav.1", audio=b"WAVDATA")
    _make_recording(env, "rec-quiet")
    # its audio never arrived: the inbox copy is gone, so every audio action must refuse
    (Path(env.store.config.datastore) / "inbox" / "rec-quiet" / "audio.wav").unlink()

    got = c.get("/admin/recordings/rec.wav.1/audio")
    assert got.status_code == 200
    assert got.content == b"WAVDATA"
    assert 'attachment; filename="rec.wav.1.wav"' in got.headers["content-disposition"]

    for path in ("/admin/recordings/rec-quiet/audio", "/admin/recordings/rec.dots/audio"):
        assert c.get(path).status_code == 404

    # no audio: show-in-folder says so too instead of launching anything
    assert c.post("/admin/recordings/rec-quiet/folder").status_code == 404

def test_handled_request_errors_are_logged_once_with_method_path_status_and_code(
    env, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="r1cord_server.app")
    c = env.client

    r = c.post("/v1/pair?debug=1", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"
    r = c.get("/v1/nonexistent?token=should-not-be-logged")
    assert r.status_code == 404 and r.json()["error"] == "not_found"

    lines = [
        rec.getMessage()
        for rec in caplog.records
        if rec.name == "r1cord_server.app" and "->" in rec.getMessage()
    ]
    assert lines == [
        "POST /v1/pair -> 422 invalid_request",
        "GET /v1/nonexistent -> 404 not_found",
    ]  # method, path (no query), status, machine code — nothing else
    assert all(rec.levelno == logging.INFO for rec in caplog.records if rec.name == "r1cord_server.app")


# --- Devices ----------------------------------------------------------------------------------------


def test_devices_page_adopt_forget_and_process(env) -> None:
    env.usb.connected = [("SERIAL1", "Rabbit_R1", False)]
    c = env.client

    page = c.get("/admin/devices").text
    assert "SERIAL1" in page and "Rabbit_R1" in page
    assert 'action="/admin/devices/SERIAL1/adopt"' in page
    assert "Nothing is pulled from a device until it is adopted." in page

    assert c.post("/admin/devices/SERIAL1/adopt", follow_redirects=False).status_code == 303
    assert env.usb.polls == 1
    assert [d for d in env.store.devices() if d.serial == "SERIAL1"][0].adopted
    assert 'action="/admin/devices/SERIAL1/forget"' in c.get("/admin/devices").text

    assert c.post("/admin/devices/SERIAL1/forget", follow_redirects=False).status_code == 303
    assert not [d for d in env.store.devices() if d.serial == "SERIAL1"][0].adopted


def test_device_process_queues_a_recording_or_reports_the_error(env) -> None:
    _make_inbox_recording(env, "rec-dev-1")
    c = env.client

    r = c.post(
        "/admin/devices/SERIAL1/recordings/rec-dev-1/process",
        data={"action": "summarize"},
        follow_redirects=False,
    )
    assert r.status_code == 303
    job_id = r.headers["location"].rsplit("/", 1)[-1]
    job = env.store.job(job_id)
    assert job is not None and job.status == "queued" and job.summarize

    r = c.post(
        "/admin/devices/SERIAL1/recordings/rec-dev-2/process",
        data={"action": "delete"},
        follow_redirects=False,
    )
    assert r.status_code == 303 and r.headers["location"].startswith("/admin/devices?error=")
    assert "rec-dev-2: invalid action: delete" in c.get(r.headers["location"]).text

    r = c.post(
        "/admin/devices/SERIAL1/recordings/rec-never-pulled/process",
        data={"action": "transcribe"},
        follow_redirects=False,
    )
    assert r.status_code == 303 and r.headers["location"].startswith("/admin/devices?error=")
    assert "no metadata.json" in c.get(r.headers["location"]).text


# --- Pairing and tokens ---------------------------------------------------------------------------


def test_pairing_code_page_and_single_use(env) -> None:
    page = env.client.post("/admin/pair").text
    code = re.search(r'class="code">(\d{6})<', page).group(1)
    assert "expires in 10 minutes" in page  # pair_code_ttl_s = 600
    assert "Server name: R1CORD" in page

    r = env.client.post("/v1/pair", json={"code": code})
    assert r.status_code == 200 and len(r.json()["token"]) == 64
    assert env.client.post("/v1/pair", json={"code": code}).json()["error"] == "invalid_code"


def test_paired_device_is_revoked_from_the_devices_page(env) -> None:
    code = env.store.create_pair_code()
    token = env.client.post("/v1/pair", json={"code": code}).json()["token"]
    row = [t for t in env.store.tokens() if not t.revoked][0]
    assert f'action="/admin/tokens/{row.id}/revoke"' in env.client.get("/admin/devices").text
    assert "/revoke" not in env.client.get("/admin").text  # pairing lives on Devices, not the dashboard

    r = env.client.post(f"/admin/tokens/{row.id}/revoke", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/admin/devices#paired"
    assert [t for t in env.store.tokens() if t.id == row.id][0].revoked
    r = env.client.get("/v1/jobs/anything", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401 and r.json()["error"] == "unauthorized"


# --- USB toggle --------------------------------------------------------------------------------------


def test_usb_toggle_flips_the_switch_and_saves_config(env) -> None:
    c = env.client
    assert c.post("/admin/usb/toggle", follow_redirects=False).status_code == 303
    assert env.app.state.config.usb_enabled is False
    assert env.usb.polls == 1
    assert load_config(env.config_path).usb_enabled is False

    c.post("/admin/usb/toggle")
    assert env.app.state.config.usb_enabled is True
    assert load_config(env.config_path).usb_enabled is True


def test_usb_poll_redirects_to_devices(env) -> None:
    r = env.client.post("/admin/usb/poll", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/admin/devices"
    assert env.usb.polls == 1


# --- Config ------------------------------------------------------------------------------------------


def _config_form(**overrides) -> dict[str, str]:
    form = {
        "server_name": "R1CORD",
        "listen_host": "127.0.0.1",
        "listen_port": "8765",
        "webdav_folder": "Z:/publish",
        "public_url_base": "https://example.test/files/",
        "theme": "Toolmaker-Noir",
        "default_writer": "codex",
        "default_summary_style": "minutes",
        "writer_timeout_s": "111",
        "claude_cmd": "claude",
        "codex_cmd": "codex",
        "grok_cmd": "grok",
        "asr_model": "large-v3-turbo",
        "asr_device": "cpu",
        "asr_language": "de",
        "pair_code_ttl_s": "77",
        "usb_enabled": "on",
        "adb_cmd": "adb",
        "usb_poll_s": "5",
        "usb_auto_action": "publish",
        "usb_device_root": "/sdcard/Download/R1CORD/",
        "run_mode": "always",
        "idle_exit_min": "15",
        "email_to": "me@example.test",
        "gws_cmd": "gws",
    }
    form.update({k: str(v) for k, v in overrides.items()})
    return form


def test_config_round_trip_email_checkbox_and_trailing_slashes(env) -> None:
    c = env.client
    page = c.get("/admin/config").text
    assert 'name="email_to"' in page and "Saved to config.toml." not in page

    # email_enabled checkbox absent = off; trailing slashes stripped; values land live + on disk.
    r = c.post("/admin/config", data=_config_form())
    assert "Saved to config.toml." in r.text
    assert RESTART_NOTE not in r.text  # listen host/port unchanged
    cfg = env.app.state.config
    assert cfg.email_enabled is False
    assert cfg.email_to == "me@example.test"
    assert cfg.default_writer == "codex" and cfg.default_summary_style == "minutes"
    assert cfg.public_url_base == "https://example.test/files"
    assert cfg.usb_device_root == "/sdcard/Download/R1CORD"
    assert cfg.asr_language == "de" and cfg.writer_timeout_s == 111
    assert env.store.config is cfg and env.app.state.worker.config is cfg  # swapped everywhere
    on_disk = load_config(env.config_path)
    assert on_disk.email_to == "me@example.test" and on_disk.listen_port == 8765

    r = c.post("/admin/config", data=_config_form(email_enabled="on"))
    assert env.app.state.config.email_enabled is True
    assert load_config(env.config_path).email_enabled is True


def test_config_invalid_enum_falls_back_and_numbers_are_clamped(env) -> None:
    c = env.client
    r = c.post("/admin/config", data=_config_form(usb_auto_action="explode", run_mode="sometimes", usb_poll_s="0"))
    assert "Saved to config.toml." in r.text  # still saves; bad values fell back
    cfg = env.app.state.config
    assert cfg.usb_auto_action == "transcribe"  # the previous value, not an invalid one
    assert cfg.run_mode == "plug"
    assert cfg.usb_poll_s == 1


def test_config_password_rotation_takes_effect_immediately(env) -> None:
    c = env.client
    c.post("/admin/config", data=_config_form(new_admin_password="rotated-pass-9"))
    assert env.app.state.config.admin_password == "rotated-pass-9"
    assert load_config(env.config_path).admin_password == "rotated-pass-9"

    assert c.get("/admin", headers=TUNNEL, auth=BASIC).status_code == 401  # old password gone
    assert c.get("/admin", headers=TUNNEL, auth=("admin", "rotated-pass-9")).status_code == 200


def test_config_port_change_shows_the_restart_note(env) -> None:
    c = env.client
    r = c.post("/admin/config", data=_config_form(listen_port="9000"))
    assert RESTART_NOTE in r.text
    assert env.app.state.config.listen_port == 9000  # saved for the next start
    r = c.post("/admin/config", data=_config_form(listen_port="9000"))  # same port again -> no note
    assert RESTART_NOTE not in r.text


# --- Import -------------------------------------------------------------------------------------------


def test_import_form_errors_and_success(env) -> None:
    c = env.client
    empty = env.tmp / "empty-folder"
    empty.mkdir()
    r = c.post("/admin/import", data={"folder": str(empty), "summarize": "on", "publish": "on"})
    assert r.status_code == 200  # re-renders the form, no redirect
    assert f"no metadata.json in {empty}" in r.text

    src = env.tmp / "importable"
    src.mkdir()
    (src / "audio.wav").write_bytes(b"0123456789abcdef")
    (src / "metadata.json").write_text(
        json.dumps({"id": "rec-import-1", "title": "Imported", "createdAt": 1_758_400_000_000}), encoding="utf-8"
    )
    r = c.post("/admin/import", data={"folder": str(src), "summarize": "on", "publish": "on"}, follow_redirects=False)
    assert r.status_code == 303
    job = env.store.job(r.headers["location"].rsplit("/", 1)[-1])
    assert job is not None and job.status == "queued" and job.summarize and job.publish
    assert job.title == "Imported"


# --- One real end-to-end email through the admin route -------------------------------------------------


def test_admin_email_end_to_end_through_a_local_gws_shim(env) -> None:
    # A real .cmd shim that answers like gws; gws_executable keeps it (no native binary beside it).
    shim = env.tmp / "gws.cmd"
    shim.write_text('@echo {"id": "mid-9"}\n', encoding="utf-8")
    env.app.state.config = replace(env.app.state.config, email_to="me@example.test", gws_cmd=str(shim))
    rec = _make_recording(env, "rec-mail-e2e")
    (env.store.outbox_dir("rec-mail-e2e") / "summary.md").write_text("# Sitting notes", encoding="utf-8")

    r = env.client.post(f"/admin/jobs/{rec.job_id}/email", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].endswith("?sent=me%40example.test")
    assert any("email: sent to me@example.test (mid-9)" in line for line in env.store.read_log(rec.job_id))


# --- Recordings list, delete, system ------------------------------------------------------------


def test_recordings_list_shows_each_recording_once_with_length_and_deletes_it(env) -> None:
    c = env.client
    first = _make_recording(env, "rec-row-1")
    env.store.set_status(first.job_id, "complete")
    rerun = env.store.process_inbox("rec-row-1", action="transcribe")
    meta = env.store.inbox_dir("rec-row-1") / "metadata.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text(encoding="utf-8")), "durationMs": 92_400}), encoding="utf-8")

    page = c.get("/admin").text
    assert page.count('class="rec-title"') == 1
    assert "2 runs" in page and "1:32" in page
    assert 'action="/admin/recordings/rec-row-1/delete"' not in page  # the rerun is still queued

    env.store.set_status(rerun.job_id, "complete")
    assert 'action="/admin/recordings/rec-row-1/delete"' in c.get("/admin").text
    r = c.post("/admin/recordings/rec-row-1/delete", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/admin?deleted=rec-row-1"
    page = c.get(r.headers["location"]).text
    assert "Deleted rec-row-1 from this PC" in page and 'class="rec-title"' not in page


def test_delete_of_a_busy_recording_reports_why(env) -> None:
    rec = _make_recording(env, "rec-busy-1")
    env.store.set_status(rec.job_id, "writing")
    r = env.client.post("/admin/recordings/rec-busy-1/delete", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/admin?notice=")
    assert "still running" in env.client.get(r.headers["location"]).text
    assert env.store.latest_for("rec-busy-1") is not None


def test_system_page_flags_email_that_is_on_without_a_recipient(env) -> None:
    env.app.state.config = replace(env.app.state.config, email_enabled=True, email_to="")
    page = env.client.get("/admin/system").text
    assert "On, but no recipient is set" in page and "Needs attention" in page
