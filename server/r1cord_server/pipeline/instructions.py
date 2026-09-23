"""INSTRUCTIONS.md for the writer CLI: a fixed wrapper around an editable prompt per AI review.

Default prompts live here. A prompt edited on the Settings page is saved as
`<dir of config.toml>/prompts/<kind>.md` and replaces the default until restored.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ..config import PAGE_LABELS, REVIEW_KINDS

MAX_PROMPT_CHARS = 8_000

DEFAULT_PROMPTS = {
    "summary": """\
Write a summary of the recording, as headings a reader can jump to from the page's Contents panel.

After the heading:
1. ## Overview: a one-paragraph abstract: what the recording is about and what came out of it.
2. ## Key points: short bullets, one idea each, the most important first. When the recording
   covers several distinct topics, group the bullets under a ### heading per topic.
3. ## Action items: a bullet list of concrete tasks, each starting with a verb. Name an owner or a
   date only when the recording does. If there are none, write "None."

Keep it concise. Use the speaker's own names for people, products and places.
""",
    "outline": """\
Write an outline of the recording: its topics and points in the order they were discussed, as
headings a reader can jump to from the page's Contents panel.

After the heading:
- Each topic is a ## heading: a short noun phrase. Sub-topics within a topic are ### headings;
  use #### only for a further level.
- Under the lowest heading, the points made as terse bullets: fragments, not sentences; about a
  dozen words per bullet at most. Supporting detail such as numbers, names or examples goes in
  nested bullets indented by four spaces.
- Keep the order of discussion. When the speaker returns to an earlier topic, give it a new
  heading where it came up instead of moving it.
- No abstract, no commentary, no conclusions the speaker did not state.
""",
    "organized": """\
Rewrite the recording as a clean, well-organized document that keeps ALL of its content.

After the heading:
- Group the content under clear ## headings (### where it helps), in a logical order: related
  material belongs together even when it was spoken at different times.
- Remove filler words, false starts, repetition and verbal tics ("um", "you know", "so, so").
- Keep the speaker's own wording and voice wherever possible. Fix grammar only where it gets in
  the way of reading. Keep first person if the speaker used it.
- Do not summarize or shorten: every fact, number, name, example, reason and opinion stays.
- Use paragraphs for narrative, and lists where the speaker enumerates things.
""",
}


class PromptError(ValueError):
    """A prompt edit that cannot be saved (empty or too long)."""


def _check_kind(kind: str) -> None:
    if kind not in REVIEW_KINDS:
        raise ValueError(f"unknown review: {kind!r} (expected summary, outline or organized)")


def prompt_path(prompts_dir: Path, kind: str) -> Path:
    _check_kind(kind)
    return Path(prompts_dir) / f"{kind}.md"


def is_custom(prompts_dir: Path | None, kind: str) -> bool:
    return prompts_dir is not None and prompt_path(prompts_dir, kind).is_file()


def load_prompt(prompts_dir: Path | None, kind: str) -> str:
    """The saved override for `kind`, else the default prompt."""
    _check_kind(kind)
    if prompts_dir is not None:
        path = prompt_path(prompts_dir, kind)
        if path.is_file():
            return path.read_text(encoding="utf-8")
    return DEFAULT_PROMPTS[kind]


def save_prompt(prompts_dir: Path, kind: str, text: str) -> None:
    """Store an edited prompt. Text equal to the default removes the override instead."""
    _check_kind(kind)
    body = text.replace("\r\n", "\n").strip()
    if not body:
        raise PromptError("The prompt is empty. Write the task, or use Restore default.")
    if len(body) > MAX_PROMPT_CHARS:
        raise PromptError(
            f"The prompt is {len(body):,} characters; the limit is {MAX_PROMPT_CHARS:,}. Shorten it and save again."
        )
    if body == DEFAULT_PROMPTS[kind].strip():
        restore_prompt(prompts_dir, kind)
        return
    path = prompt_path(prompts_dir, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body + "\n", encoding="utf-8")


def restore_prompt(prompts_dir: Path, kind: str) -> None:
    """Delete the override so the default prompt applies again."""
    prompt_path(prompts_dir, kind).unlink(missing_ok=True)


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


def build_instructions(kind: str, title: str, prompt: str, photos: list[str], metadata: dict) -> str:
    """INSTRUCTIONS.md for one review: the fixed frame around the editable `prompt`.

    The frame (output file, title heading, photos, recording facts, rules) is not editable, so a
    prompt edit cannot break the page the server publishes.
    """
    _check_kind(kind)
    name = f"{kind}.md"
    if photos:
        photo_lines = [
            "Place photos inline where they are relevant, with a real caption:",
            "![caption](photos/<file>)",
            "Use only these photo files (do not invent paths):",
            *(f"- {photo}" for photo in photos),
            "If a photo does not fit a point, put it near the top with a caption.",
        ]
    else:
        photo_lines = ["No photos. Do not add image links."]

    lines = [
        f"You are writing the {PAGE_LABELS[kind]} of an R1CORD voice recording in this working folder.",
        "",
        "Folder contents: transcript.txt (facts), transcript.json, metadata.json, photos/, this file.",
        f"Write ONLY {name} in the current working directory. Do not write any other file.",
        "",
        f"{name} must start with a heading: # {title}",
        "Everything after the heading follows the task below.",
        "",
        "## Task",
        "",
        prompt.strip(),
        "",
        "## Photos",
        "",
        *photo_lines,
        "",
        "## Recording",
        "",
        f"- title: {title}",
        f"- date: {_format_created(metadata)}",
        f"- duration: {_format_duration(metadata)}",
        "",
        "## Rules (always apply, whatever the task says)",
        "",
        "- Do not invent facts. Use only the transcript, metadata, and listed photos.",
        "- Do not invent photo paths. Use only files listed above.",
        "- Do not append the transcript. No transcript appendix.",
        f"- Keep the heading of {name} as described above.",
    ]
    return "\n".join(lines) + "\n"
