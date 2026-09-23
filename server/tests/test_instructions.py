from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline.instructions import (
    DEFAULT_PROMPTS,
    MAX_PROMPT_CHARS,
    PromptError,
    build_instructions,
    is_custom,
    load_prompt,
    restore_prompt,
    save_prompt,
)


def test_instructions_frame_the_prompt_for_that_kind() -> None:
    photos = ["photo-abc123.jpg", "photo-def456.jpg", "photo-ghi789.jpg"]
    text = build_instructions(
        "outline",
        "Site visit",
        "List every topic.",
        photos,
        {"createdAt": 1758400000000, "durationMs": 125000},
    )
    for name in photos:
        assert f"- {name}" in text
    assert "Write ONLY outline.md" in text
    assert "# Site visit" in text
    assert "brand-header" not in text  # the page header is the renderer's, never the writer's
    assert "List every topic." in text
    assert "No transcript appendix." in text
    # The fixed rules come after the editable task, so a prompt cannot talk its way past them.
    assert text.index("List every topic.") < text.index("Do not invent facts.")


def test_unknown_kind_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown review"):
        build_instructions("poem", "T", "x", [], {})


def test_no_photos_forbids_image_links() -> None:
    text = build_instructions("summary", "Road trip", DEFAULT_PROMPTS["summary"], [], {})
    assert "No photos. Do not add image links." in text
    assert "- title: Road trip" in text


def test_date_and_duration_formatting() -> None:
    text = build_instructions("summary", "T", "x", [], {"createdAt": 0, "durationMs": 125_000})
    assert "- date: 1970-01-01 00:00 UTC" in text
    assert "- duration: 2m 05s (125000 ms)" in text

    long = build_instructions("summary", "T", "x", [], {"createdAt": 0, "durationMs": 3_725_000})
    assert "- duration: 1h 02m 05s (3725000 ms)" in long


def test_missing_metadata_renders_unknown_and_bad_values_raise() -> None:
    text = build_instructions("summary", "T", "x", [], {})
    assert "- date: unknown" in text
    assert "- duration: unknown" in text

    with pytest.raises(ValueError, match="createdAt"):
        build_instructions("summary", "T", "x", [], {"createdAt": "yesterday"})
    with pytest.raises(ValueError, match="durationMs"):
        build_instructions("summary", "T", "x", [], {"durationMs": "forever"})
    with pytest.raises(ValueError, match="negative"):
        build_instructions("summary", "T", "x", [], {"durationMs": -1})


def test_prompt_override_save_load_and_restore(tmp_path: Path) -> None:
    prompts = tmp_path / "prompts"
    assert load_prompt(prompts, "organized") == DEFAULT_PROMPTS["organized"]
    assert load_prompt(None, "organized") == DEFAULT_PROMPTS["organized"]

    save_prompt(prompts, "organized", "Keep it all.\r\nEvery word.\r\n")
    assert is_custom(prompts, "organized")
    assert load_prompt(prompts, "organized") == "Keep it all.\nEvery word.\n"
    assert load_prompt(prompts, "summary") == DEFAULT_PROMPTS["summary"]  # other kinds untouched

    restore_prompt(prompts, "organized")
    assert not is_custom(prompts, "organized")
    restore_prompt(prompts, "organized")  # restoring a default is harmless

    save_prompt(prompts, "outline", DEFAULT_PROMPTS["outline"])  # saving the default is not an override
    assert not is_custom(prompts, "outline")


def test_prompt_size_cap_and_empty_prompt_are_refused_at_save(tmp_path: Path) -> None:
    prompts = tmp_path / "prompts"
    save_prompt(prompts, "summary", "x" * MAX_PROMPT_CHARS)
    with pytest.raises(PromptError, match="limit is 8,000"):
        save_prompt(prompts, "summary", "x" * (MAX_PROMPT_CHARS + 1))
    with pytest.raises(PromptError, match="empty"):
        save_prompt(prompts, "summary", "  \n ")
    assert load_prompt(prompts, "summary") == "x" * MAX_PROMPT_CHARS + "\n"  # the last good save stays
