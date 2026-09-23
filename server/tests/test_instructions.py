from __future__ import annotations

import sys
from pathlib import Path

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
