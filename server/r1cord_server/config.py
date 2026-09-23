"""Frozen Config dataclass, TOML load/save, first-run bootstrap."""

from __future__ import annotations

import logging
import os
import secrets
import string
import tomllib
from collections.abc import Iterable
from dataclasses import asdict, dataclass, fields, replace
from pathlib import Path
from typing import Any

import tomli_w

from .render import DEFAULT_THEME_ID, get_theme

_log = logging.getLogger("r1cord_server.config")


def _config_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    return (Path(base) if base else Path.home() / ".r1cord") / "R1CORD"


# Config lives beside the app data (%LOCALAPPDATA%\R1CORD); the datastore is a config field and
# may point at a bigger drive. Publish paths are empty until the user sets them.
DEFAULT_CONFIG_DIR = _config_dir()
DEFAULT_DATASTORE = DEFAULT_CONFIG_DIR / "data"
DEFAULT_WEBDAV_FOLDER = DEFAULT_CONFIG_DIR / "publish"
DEFAULT_PUBLIC_URL_BASE = ""

_PATH_FIELDS = frozenset({"datastore", "webdav_folder"})
_INT_FIELDS = frozenset({"listen_port", "writer_timeout_s", "pair_code_ttl_s", "usb_poll_s", "idle_exit_min"})
_BOOL_FIELDS = frozenset({"usb_enabled", "email_enabled"})
_REVIEW_FIELDS = frozenset({"default_reviews"})
_WRITERS = frozenset({"claude_code", "codex", "grok_build", "none"})
_ASR_DEVICES = frozenset({"auto", "cuda", "cpu"})
# `review` runs default_reviews; `publish` runs them and publishes. Config files written before AI
# reviews say `summarize`, which meant the same as `review`.
USB_ACTIONS = ("archive", "transcribe", "review", "publish")
_LEGACY_USB_ACTIONS = {"summarize": "review"}
RUN_MODES = ("plug", "always")

# AI reviews of a recording's transcript, in canonical (page) order. The transcript page comes first.
REVIEW_KINDS = ("summary", "outline", "organized")
PAGE_KINDS = ("transcript", *REVIEW_KINDS)
PAGE_LABELS = {
    "transcript": "Transcript",
    "summary": "Summary",
    "outline": "Outline",
    "organized": "Cleaned up & organized",
}
PAGE_SHORT_LABELS = {**PAGE_LABELS, "organized": "Organized"}


def canonical_reviews(kinds: Iterable[str]) -> tuple[str, ...]:
    """Review kinds in canonical order, duplicates dropped. Unknown kinds raise ValueError."""
    chosen = set()
    for kind in kinds:
        if kind not in REVIEW_KINDS:
            raise ValueError(f"unknown review: {kind!r} (expected summary, outline or organized)")
        chosen.add(kind)
    return tuple(k for k in REVIEW_KINDS if k in chosen)


def _random_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


@dataclass(frozen=True)
class Config:
    server_name: str = "R1CORD"
    listen_host: str = "127.0.0.1"
    listen_port: int = 8765
    datastore: Path = DEFAULT_DATASTORE
    webdav_folder: Path = DEFAULT_WEBDAV_FOLDER
    public_url_base: str = DEFAULT_PUBLIC_URL_BASE
    # A page theme id (render.list_themes()); files written before theme ids hold a theme name.
    theme: str = DEFAULT_THEME_ID
    default_writer: str = "claude_code"
    default_reviews: tuple[str, ...] = ("summary",)
    writer_timeout_s: int = 900
    claude_cmd: str = "claude"
    codex_cmd: str = "codex"
    grok_cmd: str = "grok"
    asr_model: str = "large-v3-turbo"
    asr_device: str = "auto"
    asr_language: str = ""
    admin_password: str = ""
    pair_code_ttl_s: int = 600
    usb_enabled: bool = True
    adb_cmd: str = "adb"
    usb_poll_s: int = 3
    usb_auto_action: str = "transcribe"
    usb_device_root: str = "/sdcard/Download/R1CORD"
    run_mode: str = "plug"
    idle_exit_min: int = 10
    # Email each finished job's AI review (or transcript) through the Google Workspace CLI (`gws`, signed in on this PC).
    email_enabled: bool = False
    email_to: str = ""
    gws_cmd: str = "gws"


def default_config_path() -> Path:
    env = os.environ.get("R1CORD_SERVER_CONFIG")
    if env:
        return Path(env)
    return DEFAULT_CONFIG_DIR / "config.toml"


def load(path: Path | None = None) -> Config:
    """Load config from TOML. Create defaults and a random admin password on first run."""
    cfg_path = path if path is not None else default_config_path()
    if not cfg_path.is_file():
        return _bootstrap(cfg_path)
    return _parse(cfg_path)


def save(config: Config, path: Path | None = None) -> None:
    dest = path if path is not None else default_config_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {}
    for key, value in asdict(config).items():
        if isinstance(value, Path):
            value = str(value)
        elif isinstance(value, tuple):
            value = list(value)
        payload[key] = value
    dest.write_text(tomli_w.dumps(payload), encoding="utf-8")


def with_updates(config: Config, **changes: Any) -> Config:
    """Return a new Config with the given fields replaced. Unknown keys are ignored; a theme name
    becomes its id, and an unknown theme raises ValueError."""
    known = {f.name for f in fields(Config)}
    cleaned: dict[str, Any] = {}
    for key, value in changes.items():
        if key not in known:
            continue
        if key in _PATH_FIELDS:
            cleaned[key] = Path(value)
        elif key in _INT_FIELDS:
            cleaned[key] = int(value)
        elif key in _BOOL_FIELDS:
            cleaned[key] = bool(value)
        elif key in _REVIEW_FIELDS:
            cleaned[key] = canonical_reviews(value)
        elif key == "theme":
            cleaned[key] = get_theme(str(value)).id
        else:
            cleaned[key] = value
    return replace(config, **cleaned)


def _bootstrap(cfg_path: Path) -> Config:
    password = _random_password()
    datastore = DEFAULT_DATASTORE if cfg_path == default_config_path() else cfg_path.parent / "data"
    config = Config(datastore=datastore, admin_password=password)
    save(config, cfg_path)
    print(
        f"r1cord-server first run. Config: {cfg_path}  Data: {datastore}",
        flush=True,
    )
    return config


def _parse(cfg_path: Path) -> Config:
    raw = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    kwargs: dict[str, Any] = {}
    for f in fields(Config):
        if f.name not in raw:
            continue
        value = raw[f.name]
        try:
            if f.name in _PATH_FIELDS:
                value = Path(value)
            elif f.name in _INT_FIELDS:
                value = int(value)
            elif f.name in _BOOL_FIELDS:
                value = bool(value)
            elif f.name in _REVIEW_FIELDS:
                if isinstance(value, str) or not isinstance(value, list):
                    raise ValueError("expected a list")
                value = canonical_reviews(value)
            elif f.name == "usb_auto_action":
                value = _LEGACY_USB_ACTIONS.get(value, value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid {f.name}: {raw[f.name]!r} ({exc})") from exc
        kwargs[f.name] = value
    config = Config(**kwargs)
    try:
        config = replace(config, theme=get_theme(config.theme).id)
    except ValueError:
        _log.warning("config: unknown theme %r, using %s", config.theme, DEFAULT_THEME_ID)
        config = replace(config, theme=DEFAULT_THEME_ID)
    if not config.admin_password:
        password = _random_password()
        config = replace(config, admin_password=password)
        save(config, cfg_path)
        print(
            f"r1cord-server generated admin password: {password}",
            flush=True,
        )
    if config.default_writer not in _WRITERS:
        raise ValueError(f"invalid default_writer: {config.default_writer}")
    if config.asr_device not in _ASR_DEVICES:
        raise ValueError(f"invalid asr_device: {config.asr_device}")
    if config.usb_auto_action not in USB_ACTIONS:
        raise ValueError(f"invalid usb_auto_action: {config.usb_auto_action}")
    if config.usb_poll_s < 1:
        raise ValueError("usb_poll_s must be >= 1")
    if config.run_mode not in RUN_MODES:
        raise ValueError(f"invalid run_mode: {config.run_mode}")
    if config.idle_exit_min < 1:
        raise ValueError("idle_exit_min must be >= 1")
    return config
