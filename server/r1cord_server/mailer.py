"""Email a finished job's AI review through the Google Workspace CLI (`gws`), signed in on this PC."""

from __future__ import annotations

import base64
import email.policy
import json
import shutil
import subprocess
from email.message import EmailMessage
from html import escape
from pathlib import Path
from typing import Any, Callable

from .config import PAGE_LABELS, Config
from .render import render_fragment
from .render.markdown import strip_brand_header
from .store import JobStore

# CreateProcess caps a command line at 32,767 characters; the message travels base64-encoded in
# `--json`, so keep it well inside that.
MAX_RAW_CHARS = 28_000
SEND_TIMEOUT_S = 90
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# The review an email carries, best first; the transcript when there is none.
EMAIL_ORDER = ("summary", "organized", "outline")


class MailError(Exception):
    """The email could not be composed or `gws` refused to send it."""


def gws_executable(cmd: str) -> str | None:
    """Resolve `gws` to its native binary.

    The npm shim (`gws.cmd`) runs through cmd.exe, which caps a command line at 8,191 characters
    and re-parses quotes; the binary it wraps takes the full 32,767 and the arguments verbatim.
    """
    path = Path(cmd)
    found = str(path) if path.is_file() else shutil.which(cmd)
    if not found:
        return None
    if Path(found).suffix.lower() in {".cmd", ".bat", ".ps1"}:
        native = (
            Path(found).parent / "node_modules" / "@googleworkspace" / "cli"
            / "node_modules" / ".bin_real" / "gws.exe"
        )
        if native.is_file():
            return str(native)
    return found


def compose(
    *,
    to: str,
    title: str,
    review_md: str | None,
    transcript: str | None,
    pages: list[dict[str, str]],
    job_url: str,
) -> EmailMessage:
    """Subject = title; body = the review (or the transcript when there is none) + a link to every
    published page (`[{"kind", "url"}]`, page order) and to the job."""
    if review_md is not None:
        body_md = strip_brand_header(review_md).strip()
    elif transcript is not None:
        body_md = transcript.strip()
    else:
        raise MailError("nothing to email: no AI review or transcript yet")
    links = [(f"{PAGE_LABELS.get(p['kind'], p['kind'])} page", p["url"]) for p in pages]
    links.append(("Job on the server PC", job_url))

    msg = _message(to, title, body_md, links, html=True)
    if len(_raw(msg)) <= MAX_RAW_CHARS:
        return msg
    msg = _message(to, title, body_md, links, html=False)
    if len(_raw(msg)) <= MAX_RAW_CHARS:
        return msg
    note = "\n\n[Truncated to fit the email. The full text is at the link below.]"
    keep = len(body_md)
    while keep > 0:
        keep = int(keep * 0.8)
        msg = _message(to, title, body_md[:keep].rstrip() + note, links, html=False)
        if len(_raw(msg)) <= MAX_RAW_CHARS:
            return msg
    raise MailError("email is too large to send")


def _message(to: str, title: str, body_md: str, links: list[tuple[str, str]], *, html: bool) -> EmailMessage:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = title
    text_links = "\n".join(f"{label}: {url}" for label, url in links)
    msg.set_content(f"{body_md}\n\n{text_links}\n")
    if html:
        # The pages' Markdown rules: raw HTML shows as text, links only to http(s), mailto and
        # anchors, photos become their captions (they only resolve on the published page).
        rendered = render_fragment(body_md)
        link_html = "".join(f'<p><a href="{escape(url)}">{escape(label)}</a></p>' for label, url in links)
        msg.add_alternative(
            '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;'
            f'max-width:680px">{rendered}<hr>{link_html}</div>',
            subtype="html",
        )
    return msg


def _raw(msg: EmailMessage) -> str:
    return base64.urlsafe_b64encode(msg.as_bytes(policy=email.policy.SMTP)).decode("ascii")


def send(config: Config, msg: EmailMessage, *, run: Callable[..., Any] = subprocess.run) -> str:
    """Send through `gws gmail users messages send`; returns the Gmail message id."""
    exe = gws_executable(config.gws_cmd)
    if exe is None:
        raise MailError(f"gws not found: {config.gws_cmd}")
    params = json.dumps({"userId": "me"})
    body = json.dumps({"raw": _raw(msg)})
    try:
        proc = run(
            [exe, "gmail", "users", "messages", "send", "--params", params, "--json", body],
            capture_output=True,
            text=True,
            timeout=SEND_TIMEOUT_S,
            creationflags=_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise MailError(f"gws timed out after {SEND_TIMEOUT_S}s") from exc
    out = proc.stdout or ""
    reply: dict[str, Any] = {}
    start = out.find("{")
    if start >= 0:
        try:
            reply = json.loads(out[start:])
        except ValueError:
            reply = {}
    if proc.returncode != 0 or "id" not in reply:
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        detail = error.get("message") or (proc.stderr or out).strip()[-300:] or f"exit {proc.returncode}"
        raise MailError(f"gws: {detail}")
    return str(reply["id"])


def email_job(
    store: JobStore,
    config: Config,
    job_id: str,
    *,
    run: Callable[..., Any] = subprocess.run,
) -> str:
    """Email one recording's best review (summary, else organized, else outline, else the transcript)
    to `config.email_to`, log it to the job, return the Gmail id."""
    to = config.email_to.strip()
    if not to:
        raise MailError("no recipient: set email_to on the Config page")
    rec = store.job(job_id)
    if rec is None:
        raise MailError(f"unknown job {job_id}")
    outbox = store.outbox_dir(rec.recording_id)
    review = next((outbox / f"{k}.md" for k in EMAIL_ORDER if (outbox / f"{k}.md").is_file()), None)
    transcript = outbox / "transcript.txt"
    msg = compose(
        to=to,
        title=rec.title or rec.recording_id,
        review_md=review.read_text(encoding="utf-8") if review is not None else None,
        transcript=transcript.read_text(encoding="utf-8") if transcript.is_file() else None,
        pages=store.pages(rec),
        job_url=f"http://127.0.0.1:{config.listen_port}/admin/jobs/{job_id}",
    )
    message_id = send(config, msg, run=run)
    store.append_log(job_id, f"email: sent to {to} ({message_id})")
    return message_id
