from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline import writers as writers_mod
from r1cord_server.pipeline.writers import (
    PROMPT,
    WriterError,
    _resolve_cmd,
    _argv_for,
    summarize,
    validate_summary,
)


class _Cfg:
    claude_cmd = "claude"
    codex_cmd = "codex"
    grok_cmd = "grok"


def test_broken_image_link_rewritten_to_italic_alt_and_logged(tmp_path: Path) -> None:
    photos = tmp_path / "photos"
    photos.mkdir()
    (photos / "ok.jpg").write_bytes(b"jpeg")
    (tmp_path / "summary.md").write_text(
        "[brand-header]\n"
        "# Visit\n\n"
        "![good shot](photos/ok.jpg)\n"
        "![also good](./photos/ok.jpg)\n"
        "![missing photo](photos/nope.jpg)\n",
        encoding="utf-8",
    )
    lines: list[str] = []
    out = validate_summary(tmp_path, lines.append)
    text = out.read_text(encoding="utf-8")
    assert "![good shot](photos/ok.jpg)" in text
    assert "![also good](./photos/ok.jpg)" in text
    assert "![missing photo](photos/nope.jpg)" not in text
    assert "*missing photo*" in text
    assert any("photos/nope.jpg" in line and "missing photo" in line for line in lines)
    assert (tmp_path / "photos" / "ok.jpg").is_file()


def test_missing_brand_header_inserted_as_first_line(tmp_path: Path) -> None:
    (tmp_path / "photos").mkdir()
    (tmp_path / "summary.md").write_text("# Title\n\nBody.\n", encoding="utf-8")
    lines: list[str] = []
    out = validate_summary(tmp_path, lines.append)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("[brand-header]\n")
    assert "# Title" in text
    assert any("brand-header" in line for line in lines)


def test_missing_or_empty_summary_raises_writer_error(tmp_path: Path) -> None:
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)
    (tmp_path / "summary.md").write_text("", encoding="utf-8")
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)
    (tmp_path / "summary.md").write_text(" \n\t\n", encoding="utf-8")
    with pytest.raises(WriterError):
        validate_summary(tmp_path, lambda _: None)


def test_valid_summary_is_left_byte_for_byte_untouched(tmp_path: Path) -> None:
    (tmp_path / "photos").mkdir()
    (tmp_path / "photos" / "p1.jpg").write_bytes(b"jpeg")
    raw = "[brand-header]\n# Title\n\n![p](photos/p1.jpg)\n"
    (tmp_path / "summary.md").write_text(raw, encoding="utf-8")

    lines: list[str] = []
    validate_summary(tmp_path, lines.append)

    assert (tmp_path / "summary.md").read_text(encoding="utf-8") == raw
    assert lines == []


def test_image_pointing_outside_photos_is_rewritten(tmp_path: Path) -> None:
    (tmp_path / "photos").mkdir()
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "escape.jpg").write_bytes(b"jpeg")
    (tmp_path / "summary.md").write_text(
        "[brand-header]\n# T\n\n![escape](../other/escape.jpg)\n", encoding="utf-8"
    )
    lines: list[str] = []
    validate_summary(tmp_path, lines.append)
    text = (tmp_path / "summary.md").read_text(encoding="utf-8")
    assert "../other/escape.jpg" not in text
    assert "*escape*" in text


def test_argv_for_each_writer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    resolved: dict[str, str] = {}

    def fake_resolve(cmd: str) -> str:
        resolved[cmd] = f"C:/bin/{cmd}.exe"
        return resolved[cmd]

    monkeypatch.setattr(writers_mod, "_resolve_cmd", fake_resolve)
    work = tmp_path / "work"
    work.mkdir()

    claude = _argv_for("claude_code", work, _Cfg)
    assert claude == [
        "C:/bin/claude.exe", "-p", PROMPT, "--add-dir", str(work),
        "--allowedTools", "Read,Write,Edit,Glob,Grep", "--permission-mode", "acceptEdits",
    ]

    codex = _argv_for("codex", work, _Cfg)
    assert codex == [
        "C:/bin/codex.exe", "exec", "-C", str(work), "--sandbox", "workspace-write",
        "--skip-git-repo-check", PROMPT,
    ]

    grok = _argv_for("grok_build", work, _Cfg)
    assert grok[0] == "C:/bin/grok.exe"
    assert grok[1:] == [
        "--prompt-file", str((work / "prompt.txt").resolve().as_posix()),
        "--cwd", str(work.resolve().as_posix()),
        "--permission-mode", "bypassPermissions",
        "--disable-web-search", "--no-subagents", "--max-turns", "40",
    ]
    # grok_build receives its prompt through a file written into the work dir
    assert (work / "prompt.txt").read_text(encoding="utf-8") == PROMPT + "\n"

    with pytest.raises(WriterError, match="unknown writer"):
        _argv_for("typewriter", work, _Cfg)


def test_resolve_cmd_reports_missing_binary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(writers_mod.shutil, "which", lambda cmd, path=None: None)
    monkeypatch.setattr(writers_mod.sys, "platform", "win32")
    with pytest.raises(WriterError, match="writer binary not found: ghost-writer"):
        _resolve_cmd("ghost-writer")


def test_resolve_cmd_appends_windows_shims(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    on_path = {"claude.cmd": "C:/shims/claude.cmd", "weird.cmd": "C:/shims/weird.cmd"}
    monkeypatch.setattr(writers_mod.shutil, "which", lambda cmd, path=None: on_path.get(cmd))
    monkeypatch.setattr(writers_mod.sys, "platform", "win32")

    assert _resolve_cmd("claude") == "C:/shims/claude.cmd"
    # A non-executable extension is stripped and the .cmd/.exe shims are tried.
    assert _resolve_cmd("weird.sh") == "C:/shims/weird.cmd"


def test_summarize_runs_command_and_returns_validated_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(
        writers_mod,
        "_argv_for",
        lambda writer, work_dir, config: [
            sys.executable,
            "-c",
            "from pathlib import Path; Path('summary.md').write_text('# Title\\n\\nbody\\n', encoding='utf-8')",
        ],
    )
    lines: list[str] = []
    out = summarize(work, writer="codex", timeout_s=60, config=_Cfg, log=lines.append)

    assert out == work / "summary.md"
    assert out.read_text(encoding="utf-8").startswith("[brand-header]\n")
    assert (work / "writer.log").read_text(encoding="utf-8").startswith("argv: ")
    assert any(line.startswith("argv: ") for line in lines)


def test_summarize_nonzero_exit_reports_code_and_log_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(
        writers_mod,
        "_argv_for",
        lambda writer, work_dir, config: [
            sys.executable, "-c", "import sys; print('model gave up'); sys.exit(3)",
        ],
    )
    with pytest.raises(WriterError, match=r"writer codex exited 3") as excinfo:
        summarize(work, writer="codex", timeout_s=60, config=_Cfg, log=lambda _l: None)
    assert "model gave up" in str(excinfo.value)


def test_summarize_timeout_kills_process_and_reports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(
        writers_mod,
        "_argv_for",
        lambda writer, work_dir, config: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    with pytest.raises(WriterError, match="timed out after 1s"):
        summarize(work, writer="grok_build", timeout_s=1, config=_Cfg, log=lambda _l: None)
    # no summary was produced and no partial state is kept beyond the log
    assert not (work / "summary.md").exists()
