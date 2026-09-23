"""MD DOCS loopback bridge client (127.0.0.1, port file or 8321)."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import httpx


class BridgeError(Exception):
    """MD DOCS bridge HTTP call failed or the app never became healthy."""


def _default_port_file() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "MD DOCS" / "mcp-bridge-port"
    return Path.home() / "AppData" / "Roaming" / "MD DOCS" / "mcp-bridge-port"


def _executable_from_md_association() -> str:
    if sys.platform != "win32":
        raise BridgeError("MD DOCS auto-launch requires Windows (.md file association)")
    import winreg  # noqa: PLC0415 — Windows only

    user_choice = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, user_choice) as key:
            progid, _ = winreg.QueryValueEx(key, "ProgId")
    except OSError as exc:
        raise BridgeError(
            f"cannot read .md UserChoice ProgId from HKCU\\{user_choice}: {exc}"
        ) from exc
    if not progid:
        raise BridgeError("HKCU .md UserChoice ProgId is empty")

    command_key = rf"{progid}\shell\open\command"
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, command_key) as key:
            command, _ = winreg.QueryValueEx(key, "")
    except OSError as exc:
        raise BridgeError(
            f"cannot read HKCR\\{command_key}: {exc}"
        ) from exc
    if not command or not str(command).strip():
        raise BridgeError(f"HKCR\\{command_key} has no default value")

    raw = os.path.expandvars(str(command).strip())
    if raw.startswith('"'):
        end = raw.find('"', 1)
        if end == -1:
            raise BridgeError(f"unclosed quote in .md open command: {raw}")
        exe = raw[1:end]
    else:
        exe = raw.split()[0]
    if not exe:
        raise BridgeError(f"could not extract executable from .md open command: {raw}")
    exe_path = Path(exe)
    if not exe_path.is_file():
        raise BridgeError(f".md handler executable not found: {exe}")
    return str(exe_path)


def _launch_detached(exe: str) -> None:
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(  # noqa: S603 — argv list, no args, shell=False
        [exe],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
        close_fds=True,
        creationflags=flags,
    )


class MdDocsBridge:
    def __init__(
        self,
        port_file: Path | None = None,
        default_port: int = 8321,
        transport=None,
    ) -> None:
        self._port_file = Path(port_file) if port_file is not None else _default_port_file()
        self._default_port = default_port
        self._transport = transport
        self._client: httpx.Client | None = None

    def port(self) -> int:
        if self._port_file.is_file():
            text = self._port_file.read_text(encoding="utf-8").strip()
            try:
                value = int(text)
            except ValueError as exc:
                raise BridgeError(
                    f"invalid bridge port in {self._port_file}: {text!r}"
                ) from exc
            if not (0 < value < 65536):
                raise BridgeError(f"invalid bridge port in {self._port_file}: {value}")
            return value
        return self._default_port

    def _http(self) -> httpx.Client:
        if self._client is None:
            kwargs: dict = {"timeout": 120.0}
            if self._transport is not None:
                kwargs["transport"] = self._transport
            self._client = httpx.Client(**kwargs)
        return self._client

    def _url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port()}{path}"

    def health(self) -> bool:
        try:
            resp = self._http().get(self._url("/health"), timeout=3.0)
        except httpx.HTTPError:
            return False
        return resp.status_code == 200

    def call(self, action: str, params: dict) -> dict:
        url = self._url(f"/tool/{action}")
        try:
            resp = self._http().post(url, json=params)
        except httpx.HTTPError as exc:
            raise BridgeError(f"{action}: request failed: {exc}") from exc
        if resp.status_code != 200:
            raise BridgeError(f"{action}: HTTP {resp.status_code}: {resp.text}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise BridgeError(f"{action}: invalid JSON: {resp.text}") from exc
        if not isinstance(data, dict):
            raise BridgeError(f"{action}: expected JSON object, got {type(data).__name__}")
        if data.get("success") is False:
            err = data.get("error", "success=false")
            raise BridgeError(f"{action}: {err}")
        return data

    def ensure_running(self, timeout_s: int = 90) -> None:
        if self.health():
            return
        exe = _executable_from_md_association()
        try:
            _launch_detached(exe)
        except OSError as exc:
            raise BridgeError(f"failed to launch MD DOCS ({exe}): {exc}") from exc
        deadline = time.monotonic() + timeout_s
        while True:
            if self.health():
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(2.0, remaining))
        raise BridgeError(
            f"MD DOCS bridge did not become healthy on 127.0.0.1:{self.port()} "
            f"within {timeout_s}s after launching {exe}"
        )
