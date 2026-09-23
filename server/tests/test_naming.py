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
