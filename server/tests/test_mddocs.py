from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import r1cord_server.mddocs as mddocs_mod
from r1cord_server.mddocs import BridgeError, MdDocsBridge


def _bridge(tmp_path: Path, handler) -> MdDocsBridge:
    return MdDocsBridge(
        port_file=tmp_path / "mcp-bridge-port",
        default_port=8321,
        transport=httpx.MockTransport(handler),
    )


def test_call_raises_bridge_error_on_success_false(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/tool/set_theme"
        return httpx.Response(200, json={"success": False, "error": "theme not found"})

    bridge = _bridge(tmp_path, handler)
    with pytest.raises(BridgeError, match="theme not found"):
        bridge.call("set_theme", {"theme": "Nope"})


def test_call_posts_to_the_port_from_the_port_file(tmp_path: Path) -> None:
    (tmp_path / "mcp-bridge-port").write_text("9123\n", encoding="utf-8")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        assert str(request.url.port) == "9123"
        return httpx.Response(200, json={"success": True})

    bridge = _bridge(tmp_path, handler)
    assert bridge.port() == 9123
    bridge.call("save_file_as", {"filePath": "X"})
    assert seen == ["/tool/save_file_as"]


def test_port_rejects_garbage_and_out_of_range_values(tmp_path: Path) -> None:
    port_file = tmp_path / "mcp-bridge-port"

    bridge = MdDocsBridge(port_file=port_file, default_port=8321)
    assert bridge.port() == 8321  # no file -> default

    for bad in ("not-a-port", "0", "65536", "-1"):
        port_file.write_text(bad, encoding="utf-8")
        with pytest.raises(BridgeError, match="invalid bridge port"):
            bridge.port()


def test_health_true_only_on_http_200(tmp_path: Path) -> None:
    def ok(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    def teapot(request: httpx.Request) -> httpx.Response:
        return httpx.Response(418)

    def dead(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert _bridge(tmp_path, ok).health() is True
    assert _bridge(tmp_path, teapot).health() is False
    assert _bridge(tmp_path, dead).health() is False


def test_call_wraps_http_failures_and_bad_payloads(tmp_path: Path) -> None:
    def http_500(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="kaboom")

    def not_json(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>not json</html>")

    def json_list(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[1, 2, 3])

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(BridgeError, match=r"open_project: HTTP 500"):
        _bridge(tmp_path, http_500).call("open_project", {})
    with pytest.raises(BridgeError, match="invalid JSON"):
        _bridge(tmp_path, not_json).call("open_project", {})
    with pytest.raises(BridgeError, match="expected JSON object"):
        _bridge(tmp_path, json_list).call("open_project", {})
    with pytest.raises(BridgeError, match="request failed"):
        _bridge(tmp_path, unreachable).call("open_project", {})


def test_ensure_running_returns_immediately_when_healthy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = MdDocsBridge(port_file=tmp_path / "port", default_port=8321)
    monkeypatch.setattr(bridge, "health", lambda: True)
    monkeypatch.setattr(
        mddocs_mod, "_executable_from_md_association", lambda: pytest.fail("must not launch when healthy")
    )
    bridge.ensure_running(timeout_s=5)


def test_ensure_running_launches_then_reports_never_healthy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge = MdDocsBridge(port_file=tmp_path / "port", default_port=8321)
    monkeypatch.setattr(bridge, "health", lambda: False)
    monkeypatch.setattr(mddocs_mod, "_executable_from_md_association", lambda: "C:/fake/MD DOCS.exe")
    launched: list[str] = []
    monkeypatch.setattr(mddocs_mod, "_launch_detached", lambda exe: launched.append(exe))

    with pytest.raises(BridgeError, match="did not become healthy"):
        bridge.ensure_running(timeout_s=0)

    assert launched == ["C:/fake/MD DOCS.exe"]


def test_ensure_running_surfaces_launch_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bridge = MdDocsBridge(port_file=tmp_path / "port", default_port=8321)
    monkeypatch.setattr(bridge, "health", lambda: False)

    def no_association() -> str:
        raise BridgeError("cannot read .md UserChoice ProgId from HKCU\\...: missing")

    monkeypatch.setattr(mddocs_mod, "_executable_from_md_association", no_association)
    with pytest.raises(BridgeError, match="cannot read .md UserChoice"):
        bridge.ensure_running(timeout_s=1)
