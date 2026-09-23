from __future__ import annotations

from datetime import datetime
from pathlib import Path

from r1cord_server.config import Config
from r1cord_server.naming import publish_folder, slugify, webdav_url


def test_slugify_basic() -> None:
    assert slugify("Site visit") == "site-visit"
    assert slugify("Hello, World!!") == "hello-world"
    assert slugify("  --Foo--  ") == "foo"
    assert slugify("") == "recording"
    assert slugify("!!!") == "recording"


def test_slugify_truncates_to_48() -> None:
    slug = slugify("a" * 80)
    assert slug == "a" * 48
    assert len(slugify("hello " + "world-" * 20)) <= 48
    assert not slugify("hello " + "world-" * 20).endswith("-")


def test_publish_folder_local_time(tmp_path: Path) -> None:
    cfg = Config(webdav_folder=tmp_path / "wd", datastore=tmp_path / "ds")
    ms = 1_758_400_000_000
    folder = publish_folder(cfg, ms, "Site visit", "rec-a")
    dt = datetime.fromtimestamp(ms / 1000)
    assert folder.name == f"{dt.strftime('%Y%m%d-%H%M')}-site-visit"
    assert folder.parent.name == dt.strftime("%m")
    assert folder.parent.parent.name == dt.strftime("%Y")
    assert folder.parent.parent.parent == cfg.webdav_folder


def test_publish_folder_collision_and_reuse(tmp_path: Path) -> None:
    cfg = Config(webdav_folder=tmp_path / "wd", datastore=tmp_path / "ds")
    ms = 1_758_400_000_000
    first = publish_folder(cfg, ms, "Site visit", "rec-a")
    first.mkdir(parents=True)
    second = publish_folder(cfg, ms, "Site visit", "rec-b")
    assert second != first
    assert second.name.endswith("-2")
    second.mkdir(parents=True)
    occupied = [(str(first), "rec-a"), (str(second), "rec-b")]
    reuse = publish_folder(cfg, ms, "Site visit", "rec-a", occupied=occupied)
    assert reuse == first
    third = publish_folder(cfg, ms, "Site visit", "rec-c", occupied=occupied)
    assert third.name.endswith("-3")


def test_publish_folder_occupied_from_index(tmp_path: Path) -> None:
    cfg = Config(webdav_folder=tmp_path / "wd", datastore=tmp_path / "ds")
    ms = 1_758_400_000_000
    first = publish_folder(cfg, ms, "Hello", "rec-a")
    second = publish_folder(
        cfg,
        ms,
        "Hello",
        "rec-b",
        occupied=[(str(first), "rec-a")],
    )
    assert second.name.endswith("-2")
    same = publish_folder(
        cfg,
        ms,
        "Hello",
        "rec-a",
        occupied=[(str(first), "rec-a")],
    )
    assert same == first


def test_webdav_url(tmp_path: Path) -> None:
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://example.test/files",
    )
    folder = cfg.webdav_folder / "2026" / "09" / "20260920-2000-site-visit"
    url = webdav_url(cfg, folder)
    assert url == "https://example.test/files/2026/09/20260920-2000-site-visit/summary.html"

def test_slugify_unicode() -> None:
    # Non-ASCII runs collapse to one dash, no matter how many code points.
    assert slugify("Café Ünicode") == "caf-nicode"
    assert slugify("日本語メモ") == "recording"


def test_slugify_emoji() -> None:
    assert slugify("👨‍👩‍👧 family") == "family"
    assert slugify("🎉") == "recording"
    assert slugify("🎉" * 100) == "recording"


def test_slugify_windows_illegal_characters() -> None:
    assert (
        slugify('What: The *Best* Day? (part 1) | "final"')
        == "what-the-best-day-part-1-final"
    )


def test_slugify_trailing_dots_and_spaces() -> None:
    assert slugify("Meeting...") == "meeting"
    assert slugify("  spaced out  ") == "spaced-out"
    assert slugify("-already dashed-") == "already-dashed"


def test_slugify_exact_48_boundary() -> None:
    assert slugify("a" * 48) == "a" * 48
    assert slugify("a" * 49) == "a" * 48
    # Truncation must not leave a trailing dash.
    assert slugify("ab " + "x" * 60) == "ab-" + "x" * 45


def test_webdav_url_trailing_slash_base(tmp_path: Path) -> None:
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://example.test/files/",
    )
    folder = cfg.webdav_folder / "2026" / "09" / "20260920-2000-site-visit"
    assert (
        webdav_url(cfg, folder)
        == "https://example.test/files/2026/09/20260920-2000-site-visit/summary.html"
    )


def test_webdav_url_empty_base(tmp_path: Path) -> None:
    cfg = Config(webdav_folder=tmp_path / "wd", datastore=tmp_path / "ds")
    folder = cfg.webdav_folder / "2026" / "09" / "20260920-2000-site-visit"
    assert (
        webdav_url(cfg, folder)
        == "/2026/09/20260920-2000-site-visit/summary.html"
    )


def test_webdav_url_encodes_segments(tmp_path: Path) -> None:
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://x.test",
    )
    folder = cfg.webdav_folder / "2026" / "09" / "20260920-2000 with space"
    assert (
        webdav_url(cfg, folder)
        == "https://x.test/2026/09/20260920-2000%20with%20space/summary.html"
    )


def test_webdav_url_folder_outside_root_uses_last_three_segments(tmp_path: Path) -> None:
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://x.test",
    )
    outside = tmp_path / "elsewhere" / "2025" / "12" / "20251209-1010-other"
    assert webdav_url(cfg, outside) == "https://x.test/2025/12/20251209-1010-other/summary.html"


def test_webdav_url_sibling_prefix_of_root_is_not_under_root(tmp_path: Path) -> None:
    # "wd2" starts with the string "wd" but is a sibling, not a child; this
    # used to raise ValueError from Path.relative_to.
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://x.test",
    )
    sibling = tmp_path / "wd2" / "2025" / "12" / "20251209-1010-other"
    assert webdav_url(cfg, sibling) == "https://x.test/2025/12/20251209-1010-other/summary.html"


def test_webdav_url_root_match_is_case_insensitive(tmp_path: Path) -> None:
    cfg = Config(
        webdav_folder=tmp_path / "wd",
        datastore=tmp_path / "ds",
        public_url_base="https://x.test",
    )
    folder = tmp_path / "WD" / "2026" / "09" / "20260920-2000-site-visit"
    assert (
        webdav_url(cfg, folder)
        == "https://x.test/2026/09/20260920-2000-site-visit/summary.html"
    )
