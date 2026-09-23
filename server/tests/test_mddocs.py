from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.mddocs import BridgeError, MdDocsBridge


def test_call_raises_bridge_error_on_success_false(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/tool/set_theme"
        return httpx.Response(200, json={"success": False, "error": "theme not found"})

    bridge = MdDocsBridge(
        port_file=tmp_path / "mcp-bridge-port",
        default_port=8321,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(BridgeError, match="theme not found"):
        bridge.call("set_theme", {"theme": "Nope"})
