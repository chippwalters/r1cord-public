from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline.instructions import build_instructions


def test_instructions_mention_every_photo_file_and_the_style() -> None:
    photos = ["photo-abc123.jpg", "photo-def456.jpg", "photo-ghi789.jpg"]
    text = build_instructions(
        title="Site visit",
        style="minutes",
        photos=photos,
        metadata={"createdAt": 1758400000000, "durationMs": 125000},
    )
    for name in photos:
        assert name in text
    assert "minutes" in text
    assert "[brand-header]" in text
    assert "photos/<file>" in text or all(f"photos/{n}" in text or n in text for n in photos)
    assert text.count("\n") <= 60


def test_unknown_style_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown summary style"):
        build_instructions("T", "poem", [], {})


def test_title_and_heading_are_embedded() -> None:
    text = build_instructions("Road trip", "notes", [], {"createdAt": 1, "durationMs": 1})
    assert "2. Then a heading: # Road trip" in text
    assert "- title: Road trip" in text
    # No photos: the writer is explicitly told not to invent image links.
    assert "No photos. Do not add image links." in text


def test_date_and_duration_formatting() -> None:
    text = build_instructions("T", "notes", [], {"createdAt": 0, "durationMs": 125_000})
    assert "- date: 1970-01-01 00:00 UTC" in text
    assert "- duration: 2m 05s (125000 ms)" in text

    long = build_instructions("T", "notes", [], {"createdAt": 0, "durationMs": 3_725_000})
    assert "- duration: 1h 02m 05s (3725000 ms)" in long


def test_missing_metadata_renders_unknown_and_bad_values_raise() -> None:
    text = build_instructions("T", "notes", [], {})
    assert "- date: unknown" in text
    assert "- duration: unknown" in text

    with pytest.raises(ValueError, match="createdAt"):
        build_instructions("T", "notes", [], {"createdAt": "yesterday"})
    with pytest.raises(ValueError, match="durationMs"):
        build_instructions("T", "notes", [], {"durationMs": "forever"})
    with pytest.raises(ValueError, match="negative"):
        build_instructions("T", "notes", [], {"durationMs": -1})


def test_too_many_photos_hits_the_line_cap() -> None:
    photos = [f"photo-{i:04d}.jpg" for i in range(40)]
    with pytest.raises(RuntimeError, match="keep it under 60"):
        build_instructions("T", "notes", photos, {})
