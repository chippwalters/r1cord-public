"""Open an Explorer window on this PC in front of the browser that asked for it.

The server is a background process. Windows refuses to let a background process put a window
in front of the one the user last clicked (the "foreground lock"), so a plain
`explorer /select,<file>` opens behind the browser and looks like nothing happened. After
launching, we find the new Explorer window and raise it while attached to the foreground
thread's input queue — the documented way a non-foreground thread may set the foreground.
If Windows still refuses, the window's taskbar button flashes instead.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

_EXPLORER_CLASS = "CabinetWClass"
_WAIT_S = 5.0


def reveal_in_explorer(path: Path) -> None:
    """Open Explorer with `path` selected and bring that window to the front."""
    before = set(_explorer_windows()) if sys.platform == "win32" else set()
    # explorer.exe returns 1 even on success; Popen and forget.
    subprocess.Popen(["explorer.exe", f"/select,{path}"])  # noqa: S603, S607
    if sys.platform == "win32":
        threading.Thread(target=_raise_when_open, args=(before, path.parent), daemon=True).start()


def _raise_when_open(before: set[int], folder: Path) -> None:
    deadline = time.monotonic() + _WAIT_S
    while time.monotonic() < deadline:
        time.sleep(0.1)
        windows = _explorer_windows()
        new = [h for h in windows if h not in before]
        # Explorer reuses a window that already shows the folder instead of opening another.
        match = new or [h for h in windows if _title(h).startswith((str(folder), folder.name))]
        if match:
            if not _bring_to_front(match[0]):
                log.info("reveal: Windows kept %s behind the foreground window; flashing it", folder)
            return
    log.info("reveal: no Explorer window for %s appeared within %.0f s", folder, _WAIT_S)


# --- Win32 --------------------------------------------------------------------------------------

def _user32():  # noqa: ANN202 - ctypes handle
    import ctypes

    return ctypes.windll.user32  # type: ignore[attr-defined]


def _explorer_windows() -> list[int]:
    import ctypes
    import ctypes.wintypes as wt

    user32 = _user32()
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def collect(hwnd: int, _lparam: int) -> bool:
        cls = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, cls, 64)
        if cls.value == _EXPLORER_CLASS and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(collect, 0)
    return found


def _title(hwnd: int) -> str:
    import ctypes

    buf = ctypes.create_unicode_buffer(512)
    _user32().GetWindowTextW(hwnd, buf, 512)
    return buf.value


def _bring_to_front(hwnd: int) -> bool:
    import ctypes
    import ctypes.wintypes as wt

    user32 = _user32()
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    SW_RESTORE = 9
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    foreground = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(foreground, None)
    me = kernel32.GetCurrentThreadId()
    attached = bool(fg_thread) and fg_thread != me and bool(user32.AttachThreadInput(me, fg_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        raised = bool(user32.SetForegroundWindow(hwnd))
    finally:
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
    if raised and user32.GetForegroundWindow() == hwnd:
        return True

    class FLASHWINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.UINT), ("hwnd", wt.HWND), ("dwFlags", wt.DWORD), ("uCount", wt.UINT), ("dwTimeout", wt.DWORD)]

    FLASHW_ALL, FLASHW_TIMERNOFG = 0x3, 0xC
    info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0)
    user32.FlashWindowEx(ctypes.byref(info))
    return False
