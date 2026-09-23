"""Claude Code / Codex / Grok Build adapters, `<kind>.md` validation, and the transcript page."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

PROMPT = "Read INSTRUCTIONS.md in this folder and do exactly what it says."

_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


class WriterError(Exception):
    """Writer CLI failed, timed out, or `<kind>.md` is missing/invalid."""


class WriterConfig(Protocol):
    claude_cmd: str
    codex_cmd: str
    grok_cmd: str


def _resolve_cmd(cmd: str) -> str:
    found = shutil.which(cmd)
    if found:
        return found
    if sys.platform == "win32":
        stem, ext = os.path.splitext(cmd)
        if not ext:
            for shim in (".cmd", ".exe", ".bat"):
                found = shutil.which(cmd + shim)
                if found:
                    return found
        elif ext.lower() not in {".cmd", ".exe", ".bat"}:
            for shim in (".cmd", ".exe"):
                found = shutil.which(stem + shim)
                if found:
                    return found
    raise WriterError(f"writer binary not found: {cmd}")


# Console CLIs spawned from a console-less pythonw server would each open a console window.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _kill_process_tree(proc: subprocess.Popen) -> None:
    pid = proc.pid
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(pid)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=_NO_WINDOW,
        )
    else:
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _tail_writer_log(work_dir: Path, n: int = 20) -> str:
    path = work_dir / "writer.log"
    if not path.is_file():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-n:])


def _image_target_path(work_dir: Path, target: str) -> Path | None:
    t = target.strip()
    if t.startswith("<") and t.endswith(">"):
        t = t[1:-1].strip()
    if not t:
        return None
    # Drop an optional title after the path.
    if t[0] in {'"', "'"}:
        quote = t[0]
        end = t.find(quote, 1)
        t = t[1:end] if end != -1 else t[1:]
    else:
        t = t.split()[0]
    t = t.replace("\\", "/")
    if t.startswith("./"):
        t = t[2:]
    photos = (work_dir / "photos").resolve()
    candidate = (work_dir / t).resolve()
    try:
        candidate.relative_to(photos)
    except ValueError:
        return None
    return candidate


def validate_review(work_dir: Path, kind: str, log: Callable[[str], None]) -> Path:
    """Require a non-empty `<kind>.md`; rewrite image links that do not resolve to a listed photo."""
    work_dir = Path(work_dir)
    name = f"{kind}.md"
    path = work_dir / name
    if not path.is_file():
        tail = _tail_writer_log(work_dir)
        extra = f"\n{tail}" if tail else ""
        raise WriterError(f"{name} missing at {path}{extra}")
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        tail = _tail_writer_log(work_dir)
        extra = f"\n{tail}" if tail else ""
        raise WriterError(f"{name} is empty at {path}{extra}")

    def _replace(match: re.Match[str]) -> str:
        alt, target = match.group(1), match.group(2)
        resolved = _image_target_path(work_dir, target)
        if resolved is not None and resolved.is_file():
            return match.group(0)
        log(f"broken image link rewritten: ![{alt}]({target}) -> *{alt}*")
        return f"*{alt}*"

    new = _IMAGE_RE.sub(_replace, raw)
    if new != raw:
        path.write_text(new, encoding="utf-8")
    return path


def _argv_for(writer: str, work_dir: Path, config: WriterConfig) -> list[str]:
    if writer == "claude_code":
        bin_path = _resolve_cmd(config.claude_cmd)
        return [
            bin_path,
            "-p",
            PROMPT,
            "--add-dir",
            str(work_dir),
            "--allowedTools",
            "Read,Write,Edit,Glob,Grep",
            "--permission-mode",
            "acceptEdits",
        ]
    if writer == "codex":
        bin_path = _resolve_cmd(config.codex_cmd)
        return [
            bin_path,
            "exec",
            "-C",
            str(work_dir),
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            PROMPT,
        ]
    if writer == "grok_build":
        bin_path = _resolve_cmd(config.grok_cmd)
        prompt_path = work_dir / "prompt.txt"
        prompt_path.write_text(PROMPT + "\n", encoding="utf-8")
        work_fwd = work_dir.resolve().as_posix()
        prompt_fwd = prompt_path.resolve().as_posix()
        return [
            bin_path,
            "--prompt-file",
            prompt_fwd,
            "--cwd",
            work_fwd,
            "--permission-mode",
            "bypassPermissions",
            "--disable-web-search",
            "--no-subagents",
            "--max-turns",
            "40",
        ]
    raise WriterError(f"unknown writer: {writer!r} (expected claude_code|codex|grok_build)")


def run_writer(
    work_dir: Path,
    *,
    kind: str,
    writer: str,
    timeout_s: int,
    config: WriterConfig,
    log: Callable[[str], None],
) -> Path:
    """Run the writer CLI in `work_dir` (holding that review's INSTRUCTIONS.md) and return the
    validated `<kind>.md` path."""
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    argv = _argv_for(writer, work_dir, config)
    log_path = work_dir / "writer.log"
    argv_line = "argv: " + repr(argv)
    log(argv_line)
    with log_path.open("a", encoding="utf-8", errors="replace") as fh:
        fh.write(argv_line + "\n")
        fh.flush()
        proc = subprocess.Popen(  # noqa: S603 — argv list, shell=False
            argv,
            cwd=str(work_dir),
            stdin=subprocess.DEVNULL,
            stdout=fh,
            stderr=subprocess.STDOUT,
            shell=False,
            creationflags=_NO_WINDOW,
        )
        try:
            rc = proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired as exc:
            _kill_process_tree(proc)
            tail = _tail_writer_log(work_dir)
            extra = f"\n{tail}" if tail else ""
            raise WriterError(f"writer {writer} timed out after {timeout_s}s{extra}") from exc
    if rc != 0:
        tail = _tail_writer_log(work_dir)
        extra = f"\n{tail}" if tail else ""
        raise WriterError(f"writer {writer} exited {rc}{extra}")
    return validate_review(work_dir, kind, log)


_MD_SPECIAL = re.compile(r"([\\`*_\[\]<>#|])")
_MD_LINE_START = re.compile(r"^(\s*)(?:([-+])|(\d+)([.)]))(?=\s|$)", re.MULTILINE)


def _escape_markdown(text: str) -> str:
    """Spoken words, not Markdown: keep a transcript line from turning into a heading, list,
    quote, link or tag when the page is rendered."""
    text = _MD_SPECIAL.sub(r"\\\1", text)

    def _line_start(m: re.Match[str]) -> str:
        if m.group(2):
            return f"{m.group(1)}\\{m.group(2)}"
        return f"{m.group(1)}{m.group(3)}\\{m.group(4)}"

    return _MD_LINE_START.sub(_line_start, text)


def transcript_markdown(title: str, when: str, transcript: str) -> str:
    """The transcript page source: `# title`, a date · duration line, then the transcript's
    paragraphs."""
    paragraphs = [p.strip() for p in transcript.replace("\r\n", "\n").split("\n\n") if p.strip()]
    body = "\n\n".join(_escape_markdown(p) for p in paragraphs)
    parts = [f"# {title}", ""]
    if when:
        parts += [f"*{when}*", ""]
    parts.append(body or "*No speech was recognized.*")
    return "\n".join(parts) + "\n"
