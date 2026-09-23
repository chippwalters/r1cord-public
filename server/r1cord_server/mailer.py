"""Email a finished job's summary through the Google Workspace CLI (`gws`), signed in on this PC."""

from __future__ import annotations

import base64
import email.policy
import json
import re
import shutil
import subprocess
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable

import markdown

from .config import Config
from .store import JobStore

# CreateProcess caps a command line at 32,767 characters; the message travels base64-encoded in
# `--json`, so keep it well inside that.
MAX_RAW_CHARS = 28_000
SEND_TIMEOUT_S = 90
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_BRAND_HEADER = re.compile(r"^\s*\[brand-header\]\s*\n", re.IGNORECASE)
_IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_RELATIVE_REF = re.compile(r'(\b(?:src|href)=")(?![a-z][a-z0-9+.-]*:|#|/)([^"]+)"', re.IGNORECASE)
_NOT_AN_ENTITY = re.compile(r"&(?![A-Za-z][A-Za-z0-9]{1,31};|#\d{1,10};|#x[0-9A-Fa-f]{1,8};)")


def _escape_raw_html(md: str) -> str:
    """Neutralize raw HTML in the markdown source before it is rendered.

    Summaries and transcripts are LLM-written text that reaches an HTML email part;
    python-markdown passes embedded HTML through verbatim, so anything that looks
    like a tag is shown as text instead. Only `<` is escaped (a bare `>` cannot
    open a tag, and `>` at line start is blockquote syntax), and `&` only when it
    is not already an entity reference.
    """
    return _NOT_AN_ENTITY.sub("&amp;", md).replace("<", "&lt;")


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
    summary_md: str | None,
    transcript: str | None,
    page_url: str | None,
    job_url: str,
) -> EmailMessage:
    """Subject = title; body = the summary (or the transcript when there is no summary) + links."""
    if summary_md is not None:
        body_md = _BRAND_HEADER.sub("", summary_md, count=1).strip()
    elif transcript is not None:
        body_md = transcript.strip()
    else:
        raise MailError("nothing to email: no summary or transcript yet")
    links = [("Published page", page_url)] if page_url else []
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
        page_url = links[0][1] if links[0][0] == "Published page" else None
        rendered = markdown.markdown(_escape_raw_html(body_md), extensions=["extra", "sane_lists"])
        if page_url:
            base = page_url.rsplit("/", 1)[0] + "/"
            rendered = _RELATIVE_REF.sub(lambda m: f'{m.group(1)}{base}{m.group(2)}"', rendered)
        else:
            rendered = _IMG.sub("", rendered)  # photo paths only resolve on the published page
        link_html = "".join(f'<p><a href="{url}">{label}</a></p>' for label, url in links)
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
    """Email one job's summary to `config.email_to`, log it to the job, return the Gmail id."""
    to = config.email_to.strip()
    if not to:
        raise MailError("no recipient: set email_to on the Config page")
    rec = store.job(job_id)
    if rec is None:
        raise MailError(f"unknown job {job_id}")
    outbox = store.outbox_dir(rec.recording_id)
    summary = outbox / "summary.md"
    transcript = outbox / "transcript.txt"
    result = store.result_json(job_id)
    msg = compose(
        to=to,
        title=rec.title or rec.recording_id,
        summary_md=summary.read_text(encoding="utf-8") if summary.is_file() else None,
        transcript=transcript.read_text(encoding="utf-8") if transcript.is_file() else None,
        page_url=result.get("webdavUrl") or None,
        job_url=f"http://127.0.0.1:{config.listen_port}/admin/jobs/{job_id}",
    )
    message_id = send(config, msg, run=run)
    store.append_log(job_id, f"email: sent to {to} ({message_id})")
    return message_id
