from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline.publish import PublishError, publish


class FakeBridge:
    """Records actions; emulates MD DOCS writing summary.html on `publish`."""

    def __init__(self, *, fail_on: str | None = None, write_html: bool = True) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.fail_on = fail_on
        self.write_html = write_html
        self.folder: Path | None = None

    def ensure_running(self) -> None:
        self.calls.append(("ensure_running", {}))
        if self.fail_on == "ensure_running":
            raise RuntimeError("bridge is dead")

    def call(self, action: str, params: dict) -> dict:
        self.calls.append((action, dict(params)))
        if action == self.fail_on:
            raise RuntimeError(f"{action} exploded")
        if action == "open_project":
            self.folder = Path(params["folderPath"])
        if action == "publish" and self.write_html and self.folder is not None:
            (self.folder / "summary.html").write_text("<html>doc</html>", encoding="utf-8")
        return {"success": True}


def _outbox(tmp_path: Path) -> Path:
    outbox = tmp_path / "outbox"
    photos = outbox / "photos"
    photos.mkdir(parents=True)
    (outbox / "summary.md").write_text("[brand-header]\n# Site visit\n\nbody\n", encoding="utf-8")
    (photos / "photo-a.jpg").write_bytes(b"jpeg-a")
    return outbox


def test_publish_drives_bridge_steps_in_order_with_windows_paths(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    folder = tmp_path / "webdav" / "2026" / "09" / "site-visit"
    bridge = FakeBridge()
    lines: list[str] = []

    html = publish(
        outbox / "summary.md", outbox / "photos", folder,
        theme="Toolmaker-Noir", bridge=bridge, log=lines.append,
    )

    assert [a for a, _ in bridge.calls] == [
        "ensure_running", "open_project", "load_file", "refresh_file", "set_theme", "save_file_as", "publish",
    ]
    params = {a: p for a, p in bridge.calls}
    assert Path(params["open_project"]["folderPath"]) == folder
    assert params["open_project"]["folderPath"] == str(folder).replace("/", "\\")
    staged_md = outbox / "publish" / "summary.md"
    assert Path(params["load_file"]["filePath"]) == staged_md
    assert params["set_theme"] == {"theme": "Toolmaker-Noir"}
    assert Path(params["save_file_as"]["filePath"]) == folder / "summary.md"
    assert html == folder / "summary.html"
    assert html.read_text(encoding="utf-8") == "<html>doc</html>"
    assert any(a == "publish" for a, _ in bridge.calls)
    assert lines  # progress is reported through the job log


def test_publish_stages_summary_and_photos_and_replaces_stale_photos(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    staged_photos = outbox / "publish" / "photos"
    staged_photos.mkdir(parents=True)
    (staged_photos / "leftover.jpg").write_bytes(b"stale")  # from an earlier publish
    original = (outbox / "summary.md").read_bytes()
    bridge = FakeBridge()

    publish(outbox / "summary.md", outbox / "photos", tmp_path / "pub",
            theme="t", bridge=bridge, log=lambda _l: None)

    staged = outbox / "publish"
    assert (staged / "summary.md").read_bytes() == original
    assert sorted(p.name for p in staged_photos.iterdir()) == ["photo-a.jpg"]
    assert (staged_photos / "photo-a.jpg").read_bytes() == b"jpeg-a"
    assert (outbox / "summary.md").read_bytes() == original  # outbox copy untouched


def test_bridge_step_failure_stops_and_leaves_outbox_untouched(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    original = (outbox / "summary.md").read_bytes()
    bridge = FakeBridge(fail_on="set_theme")

    with pytest.raises(PublishError, match="set_theme"):
        publish(outbox / "summary.md", outbox / "photos", tmp_path / "pub",
                theme="t", bridge=bridge, log=lambda _l: None)

    assert [a for a, _ in bridge.calls] == ["ensure_running", "open_project", "load_file", "refresh_file", "set_theme"]
    assert (outbox / "summary.md").read_bytes() == original
    assert not (tmp_path / "pub" / "summary.html").exists()


def test_unhealthy_bridge_raises_publish_error_before_any_step(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    bridge = FakeBridge(fail_on="ensure_running")

    with pytest.raises(PublishError, match="MD DOCS bridge is not running"):
        publish(outbox / "summary.md", outbox / "photos", tmp_path / "pub",
                theme="t", bridge=bridge, log=lambda _l: None)

    assert bridge.calls == [("ensure_running", {})]


def test_missing_html_after_publish_raises(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    bridge = FakeBridge(write_html=False)

    with pytest.raises(PublishError, match="did not write"):
        publish(outbox / "summary.md", outbox / "photos", tmp_path / "pub",
                theme="t", bridge=bridge, log=lambda _l: None)


def test_missing_summary_or_photos_dir_raises(tmp_path: Path) -> None:
    outbox = _outbox(tmp_path)
    bridge = FakeBridge()

    with pytest.raises(PublishError, match="summary.md not found"):
        publish(outbox / "missing.md", outbox / "photos", tmp_path / "pub",
                theme="t", bridge=bridge, log=lambda _l: None)
    assert bridge.calls == []  # nothing ran

    (outbox / "photos").rename(outbox / "photos-away")
    with pytest.raises(PublishError, match="photos dir not found"):
        publish(outbox / "summary.md", outbox / "photos", tmp_path / "pub",
                theme="t", bridge=bridge, log=lambda _l: None)
    assert bridge.calls == []
