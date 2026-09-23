"""Claude Code / Codex / Grok Build adapters and summary.md validation."""

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
    """Writer CLI failed, timed out, or summary.md is missing/invalid."""


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


def validate_summary(work_dir: Path, log: Callable[[str], None]) -> Path:
    """Require a non-empty summary.md; rewrite broken images; ensure [brand-header]."""
    work_dir = Path(work_dir)
    path = work_dir / "summary.md"
    if not path.is_file():
        tail = _tail_writer_log(work_dir)
        extra = f"\n{tail}" if tail else ""
        raise WriterError(f"summary.md missing at {path}{extra}")
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        tail = _tail_writer_log(work_dir)
        extra = f"\n{tail}" if tail else ""
        raise WriterError(f"summary.md is empty at {path}{extra}")

    def _replace(match: re.Match[str]) -> str:
        alt, target = match.group(1), match.group(2)
        resolved = _image_target_path(work_dir, target)
        if resolved is not None and resolved.is_file():
            return match.group(0)
        log(f"broken image link rewritten: ![{alt}]({target}) -> *{alt}*")
        return f"*{alt}*"

    new = _IMAGE_RE.sub(_replace, raw)
    lines = new.splitlines()
    first_nonempty = next((ln.strip() for ln in lines if ln.strip()), "")
    if first_nonempty != "[brand-header]":
        log("inserted [brand-header] as first line")
        new = "[brand-header]\n" + new
        if not new.endswith("\n") and raw.endswith("\n"):
            new += "\n"
    elif not new.endswith("\n") and raw.endswith("\n"):
        new += "\n"
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


def summarize(
    work_dir: Path,
    *,
    writer: str,
    timeout_s: int,
    config: WriterConfig,
    log: Callable[[str], None],
) -> Path:
    """Run the writer CLI in `work_dir` and return the validated summary.md path."""
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
    return validate_summary(work_dir, log)
