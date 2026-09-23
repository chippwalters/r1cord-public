from __future__ import annotations

import base64
import email.policy
import json
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from r1cord_server.config import Config
from r1cord_server.mailer import MAX_RAW_CHARS, MailError, _raw, compose, email_job, gws_executable, send
from r1cord_server.store import JobStore

PAGE = "https://example.test/files/2026/09/rec/summary.html"
JOB = "http://127.0.0.1:8765/admin/jobs/j1"


def _parts(msg) -> dict[str, str]:
    return {part.get_content_type(): part.get_content() for part in msg.walk() if not part.is_multipart()}


def test_compose_renders_the_summary_with_links_resolved_against_the_published_page() -> None:
    summary = "[brand-header]\n# Site visit\n\nAbstract.\n\n![Gate](photos/photo-1.jpg)\n\n- point\n"
    msg = compose(to="me@example.test", title="Site visit", summary_md=summary, transcript="t", page_url=PAGE, job_url=JOB)
    parts = _parts(msg)
    assert msg["Subject"] == "Site visit"
    assert "[brand-header]" not in parts["text/plain"]
    html = parts["text/html"]
    assert '<img alt="Gate" src="https://example.test/files/2026/09/rec/photos/photo-1.jpg"' in html
    assert f'href="{PAGE}"' in html and f'href="{JOB}"' in html


def test_compose_without_a_page_drops_photos_and_falls_back_to_the_transcript() -> None:
    msg = compose(to="me@example.test", title="T", summary_md=None, transcript="Hello there.", page_url=None, job_url=JOB)
    parts = _parts(msg)
    assert "Hello there." in parts["text/plain"]
    assert "Published page" not in parts["text/plain"]
    with pytest.raises(MailError):
        compose(to="me@example.test", title="T", summary_md=None, transcript=None, page_url=None, job_url=JOB)


def test_compose_shrinks_to_fit_the_command_line() -> None:
    # Big enough that HTML + text overflow, but text alone fits: HTML part is dropped.
    medium = "word " * 3200
    msg = compose(to="me@example.test", title="T", summary_md=medium, transcript=None, page_url=PAGE, job_url=JOB)
    assert set(_parts(msg)) == {"text/plain"}
    assert len(_raw(msg)) <= MAX_RAW_CHARS
    # Too big even as text: truncated with a pointer to the page, links kept.
    huge = "word " * 20000
    msg = compose(to="me@example.test", title="T", summary_md=huge, transcript=None, page_url=PAGE, job_url=JOB)
    text = _parts(msg)["text/plain"]
    assert len(_raw(msg)) <= MAX_RAW_CHARS
    assert "[Truncated to fit the email." in text and PAGE in text


def test_send_returns_the_gmail_id_and_surfaces_gws_errors(tmp_path: Path) -> None:
    exe = tmp_path / "gws.exe"
    exe.write_bytes(b"")
    cfg = Config(datastore=tmp_path / "ds", webdav_folder=tmp_path / "wd", gws_cmd=str(exe))
    msg = compose(to="me@example.test", title="T", summary_md="Hi", transcript=None, page_url=None, job_url=JOB)
    calls: list[list[str]] = []

    def ok(args, **_kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout='{\n  "id": "abc123",\n  "labelIds": ["SENT"]\n}', stderr="Using keyring backend: keyring")

    assert send(cfg, msg, run=ok) == "abc123"
    assert calls[0][:5] == [str(exe), "gmail", "users", "messages", "send"]
    def refused(args, **_kw):
        return subprocess.CompletedProcess(args, 1, stdout='{"error": {"code": 403, "message": "Insufficient Permission"}}', stderr="")

    with pytest.raises(MailError, match="Insufficient Permission"):
        send(cfg, msg, run=refused)



def test_gws_executable_resolves_shims_plain_exes_and_reports_missing(tmp_path: Path) -> None:
    # A .cmd shim hides a native binary one level deeper; that binary is preferred.
    shim = tmp_path / "gws.cmd"
    shim.write_text("@echo off\n", encoding="utf-8")
    native = (
        tmp_path / "node_modules" / "@googleworkspace" / "cli"
        / "node_modules" / ".bin_real" / "gws.exe"
    )
    native.parent.mkdir(parents=True)
    native.write_bytes(b"")
    assert gws_executable(str(shim)) == str(native)

    # A shim with no native binary beside it stays the shim (still runs, just capped).
    lonely = tmp_path / "solo" / "gws.cmd"
    lonely.parent.mkdir()
    lonely.write_text("@echo off\n", encoding="utf-8")
    assert gws_executable(str(lonely)) == str(lonely)

    exe = tmp_path / "gws.exe"
    exe.write_bytes(b"")
    assert gws_executable(str(exe)) == str(exe)
    assert gws_executable(str(tmp_path / "missing" / "gws.exe")) is None


def test_compose_subject_and_recipient_with_unicode_survive_the_wire() -> None:
    title = "Standup — naïve café ✓"
    msg = compose(to="üser@example.test", title=title, summary_md="x", transcript=None, page_url=None, job_url=JOB)
    assert _raw(msg).isascii()  # base64 payload of an SMTP-serialised message must be
    parsed = email.message_from_string(msg.as_string(policy=email.policy.SMTP), policy=email.policy.SMTP)
    assert parsed["Subject"] == title
    assert parsed["To"] == "üser@example.test"


def test_compose_shows_raw_html_in_the_summary_as_text_never_as_tags() -> None:
    summary = (
        "# Notes\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n"
        "AT&T <b>bold</b>\n\n> a quote\n\n![Gate](photos/photo-1.jpg)\n"
    )
    msg = compose(to="me@example.test", title="T", summary_md=summary, transcript=None, page_url=PAGE, job_url=JOB)
    parts = _parts(msg)
    html = parts["text/html"]
    assert "<script>" not in html and "<img src=x" not in html and "<b>bold</b>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "AT&amp;T" in html  # a bare & became an entity, an existing entity is left alone
    assert "<blockquote>" in html and "a quote" in html  # markdown blockquotes still work
    # markdown-authored content still renders: the image was written as markdown, not raw HTML
    assert '<img alt="Gate" src="https://example.test/files/2026/09/rec/photos/photo-1.jpg"' in html
    # the plain-text twin keeps the literal source
    assert "<script>alert(1)</script>" in parts["text/plain"]


def test_send_times_out_into_mail_error(tmp_path: Path) -> None:
    exe = tmp_path / "gws.exe"
    exe.write_bytes(b"")
    cfg = Config(datastore=tmp_path / "ds", webdav_folder=tmp_path / "wd", gws_cmd=str(exe))
    msg = compose(to="me@example.test", title="T", summary_md="Hi", transcript=None, page_url=None, job_url=JOB)

    def hang(args, **_kw):
        raise subprocess.TimeoutExpired(args, 90)

    with pytest.raises(MailError, match="timed out after 90s"):
        send(cfg, msg, run=hang)


def _store_with_one_job(tmp_path: Path) -> tuple[JobStore, Config, str]:
    exe = tmp_path / "gws.exe"
    exe.write_bytes(b"")
    cfg = Config(
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        email_to="me@example.test",
        gws_cmd=str(exe),
    )
    store = JobStore(cfg)
    src = tmp_path / "src" / "rec-1"
    src.mkdir(parents=True)
    (src / "audio.wav").write_bytes(b"0123456789abcdef")
    (src / "metadata.json").write_text(
        json.dumps({"id": "rec-1", "title": "Kickoff", "createdAt": 1_758_400_000_000}), encoding="utf-8"
    )
    rec = store.import_folder(src, title="Kickoff", summarize=True, publish=False, style="notes")
    return store, cfg, rec.job_id


def test_email_job_refuses_blank_recipient_and_unknown_jobs(tmp_path: Path) -> None:
    store, cfg, job_id = _store_with_one_job(tmp_path)
    with pytest.raises(MailError, match="no recipient"):
        email_job(store, replace(cfg, email_to="   "), job_id)
    with pytest.raises(MailError, match="unknown job ghost"):
        email_job(store, cfg, "ghost")


def test_email_job_without_a_summary_sends_the_transcript_and_logs_it(tmp_path: Path) -> None:
    store, cfg, job_id = _store_with_one_job(tmp_path)
    (store.outbox_dir("rec-1") / "transcript.txt").write_text("hello from the transcript", encoding="utf-8")
    sent: list[list[str]] = []

    def ok(args, **_kw):
        sent.append(args)
        return subprocess.CompletedProcess(args, 0, stdout='{"id": "mid-7"}')

    assert email_job(store, cfg, job_id, run=ok) == "mid-7"
    body = json.loads(sent[0][sent[0].index("--json") + 1])["raw"]
    mail = base64.urlsafe_b64decode(body).decode("utf-8")
    assert "hello from the transcript" in mail  # transcript became the body
    assert "Subject: Kickoff" in mail
    assert any("email: sent to me@example.test (mid-7)" in line for line in store.read_log(job_id))
