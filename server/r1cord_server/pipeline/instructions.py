"""INSTRUCTIONS.md text for the writer CLI."""

from __future__ import annotations

from datetime import datetime, timezone

_STYLE_HINTS = {
    "notes": (
        "Write concise working notes. Short bullets under Key points. "
        "Action items are checkable tasks, not prose."
    ),
    "minutes": (
        "Write meeting minutes: who said what that mattered, decisions, and owners. "
        "Use timestamps only when they mark a decision."
    ),
    "article": (
        "Write a short article in prose under the abstract and Key points. "
        "Action items stay a list at the end."
    ),
}


def _format_created(metadata: dict) -> str:
    raw = metadata.get("createdAt")
    if raw is None:
        return "unknown"
    try:
        ms = int(raw)
        dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except (TypeError, ValueError, OSError, OverflowError) as exc:
        raise ValueError(f"metadata.createdAt is not epoch milliseconds: {raw!r}") from exc


def _format_duration(metadata: dict) -> str:
    raw = metadata.get("durationMs")
    if raw is None:
        return "unknown"
    try:
        ms = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"metadata.durationMs is not an integer: {raw!r}") from exc
    if ms < 0:
        raise ValueError(f"metadata.durationMs is negative: {ms}")
    seconds = ms // 1000
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {sec:02d}s ({ms} ms)"
    return f"{minutes}m {sec:02d}s ({ms} ms)"


def build_instructions(title: str, style: str, photos: list[str], metadata: dict) -> str:
    """Return INSTRUCTIONS.md body (under 60 lines) for the writer cwd."""
    if style not in _STYLE_HINTS:
        raise ValueError(f"unknown summary style: {style!r} (expected notes|minutes|article)")
    photo_lines: list[str]
    if photos:
        photo_lines = [
            "Place photos inline where they are relevant, with a real caption:",
            "![caption](photos/<file>)",
            "Use only these photo files (do not invent paths):",
        ]
        photo_lines.extend(f"- {name}" for name in photos)
        photo_lines.append("If a photo does not fit a point, put it after the abstract with a caption.")
    else:
        photo_lines = ["No photos. Do not add image links."]

    lines = [
        "You are summarizing an R1CORD voice recording in this working folder.",
        "",
        "Folder contents: transcript.txt (facts), transcript.json, metadata.json, photos/, this file.",
        "Write ONLY summary.md in the current working directory. Do not write any other file.",
        "",
        "Required structure of summary.md:",
        "1. First line must be exactly: [brand-header]",
        f"2. Then a heading: # {title}",
        "3. Then a one-paragraph abstract.",
        "4. Then ## Key points",
        "5. Then ## Action items",
        *photo_lines,
        "",
        "Recording:",
        f"- title: {title}",
        f"- date: {_format_created(metadata)}",
        f"- duration: {_format_duration(metadata)}",
        f"- summary style: {style}",
        "",
        f"Style rules for {style}: {_STYLE_HINTS[style]}",
        "",
        "Rules:",
        "- Do not invent facts. Use only the transcript, metadata, and listed photos.",
        "- Do not invent photo paths. Use only files listed above.",
        "- Do not append the transcript. No transcript appendix.",
        "- No timestamps unless the style is minutes and a time marks a decision.",
    ]
    text = "\n".join(lines) + "\n"
    line_count = text.count("\n")
    if line_count > 60:
        raise RuntimeError(f"INSTRUCTIONS.md is {line_count} lines; keep it under 60")
    return text
