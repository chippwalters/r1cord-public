from __future__ import annotations

import logging
from pathlib import Path

import pytest

from r1cord_server.config import Config, load, save, with_updates


def _write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def test_round_trip_all_field_types(tmp_path: Path) -> None:
    cfg = Config(
        server_name="Desk",
        listen_host="0.0.0.0",
        listen_port=9000,
        datastore=tmp_path / "ds",
        webdav_folder=tmp_path / "wd",
        public_url_base="https://x.test/pub/",
        theme="github-light",
        default_writer="codex",
        default_reviews=("outline", "organized"),
        writer_timeout_s=30,
        claude_cmd="claude1",
        codex_cmd="codex1",
        grok_cmd="grok1",
        asr_model="tiny",
        asr_device="cpu",
        asr_language="de",
        admin_password="pw-with-symbols-!?",
        pair_code_ttl_s=60,
        usb_enabled=False,
        adb_cmd="adb1",
        usb_poll_s=7,
        usb_auto_action="publish",
        usb_device_root="/sdcard/X",
        run_mode="always",
        idle_exit_min=45,
        email_enabled=True,
        email_to="someone@example.test",
        gws_cmd="gws1",
    )
    path = tmp_path / "config.toml"
    save(cfg, path)
    assert load(path) == cfg  # Paths, bools, ints, empty and slashy strings survive


def test_first_run_bootstrap_creates_password_and_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("R1CORD_SERVER_CONFIG", raising=False)
    path = tmp_path / "nested" / "config.toml"
    cfg = load(path)
    assert path.is_file()
    assert len(cfg.admin_password) == 16
    assert cfg.admin_password.isalnum()
    assert cfg.datastore == path.parent / "data"  # data lives beside a non-default config
    assert load(path) == cfg  # the saved file round-trips


def test_load_empty_password_generates_and_persists(tmp_path: Path) -> None:
    path = _write(tmp_path / "config.toml", 'server_name = "KeepMe"\n')
    cfg = load(path)
    assert cfg.server_name == "KeepMe"
    assert len(cfg.admin_password) == 16
    assert cfg.admin_password in path.read_text(encoding="utf-8")  # written back to disk


def test_unknown_keys_ignored(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "config.toml",
        'server_name = "X"\nfuture_field = 42\n[a_table]\nkey = "v"\n',
    )
    cfg = load(path)
    assert cfg.server_name == "X"


@pytest.mark.parametrize(
    ("snippet", "field"),
    [
        ('default_writer = "bogus"\n', "default_writer"),
        ('asr_device = "gpu"\n', "asr_device"),
        ('default_reviews = ["summary", "poem"]\n', "default_reviews"),
        ('default_reviews = "summary"\n', "default_reviews"),
        ('usb_auto_action = "detonate"\n', "usb_auto_action"),
        ('run_mode = "sometimes"\n', "run_mode"),
        ("usb_poll_s = 0\n", "usb_poll_s"),
        ("idle_exit_min = 0\n", "idle_exit_min"),
        ('listen_port = "abc"\n', "listen_port"),
        ("datastore = 123\n", "datastore"),
        ("pair_code_ttl_s = [1]\n", "pair_code_ttl_s"),
    ],
)
def test_parse_errors_name_the_field(tmp_path: Path, snippet: str, field: str) -> None:
    path = _write(tmp_path / "config.toml", snippet)
    with pytest.raises(ValueError) as exc:
        load(path)
    assert field in str(exc.value)


def test_config_from_before_ai_reviews_still_loads(tmp_path: Path) -> None:
    """Customers' config.toml files name the removed summary style and the old `summarize` action."""
    path = _write(
        tmp_path / "config.toml",
        'admin_password = "pw"\ndefault_summary_style = "minutes"\nusb_auto_action = "summarize"\n',
    )
    cfg = load(path)
    assert cfg.usb_auto_action == "review"
    assert cfg.default_reviews == ("summary",)
    save(cfg, path)
    assert "default_summary_style" not in path.read_text(encoding="utf-8")
    assert load(path) == cfg


def test_default_reviews_load_in_canonical_order(tmp_path: Path) -> None:
    path = _write(tmp_path / "config.toml", 'admin_password = "pw"\ndefault_reviews = ["organized", "summary", "organized"]\n')
    assert load(path).default_reviews == ("summary", "organized")
    empty = _write(tmp_path / "empty.toml", 'admin_password = "pw"\ndefault_reviews = []\n')
    assert load(empty).default_reviews == ()


def test_parse_int_coercion_from_string(tmp_path: Path) -> None:
    path = _write(tmp_path / "config.toml", 'listen_port = "8123"\nusb_poll_s = "5"\n')
    cfg = load(path)
    assert cfg.listen_port == 8123 and cfg.usb_poll_s == 5


def test_with_updates_coercion_and_unknown_keys() -> None:
    base = Config()
    updated = with_updates(
        base,
        datastore="C:/tmp/elsewhere",
        listen_port="9100",
        usb_enabled="yes",
        server_name="Renamed",
        bogus_key=123,
    )
    assert updated.datastore == Path("C:/tmp/elsewhere")
    assert updated.listen_port == 9100
    assert updated.usb_enabled is True
    assert updated.server_name == "Renamed"
    assert not hasattr(updated, "bogus_key")
    assert base.server_name == "R1CORD"  # source config untouched


def test_email_and_run_mode_fields_parse(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "config.toml",
        'email_enabled = true\nemail_to = "a@b.test"\ngws_cmd = "gws9"\nrun_mode = "always"\n',
    )
    cfg = load(path)
    assert cfg.email_enabled is True
    assert cfg.email_to == "a@b.test"
    assert cfg.gws_cmd == "gws9"
    assert cfg.run_mode == "always"


def test_theme_name_from_an_older_config_loads_as_its_id(tmp_path: Path) -> None:
    path = _write(tmp_path / "config.toml", 'admin_password = "pw"\ntheme = "Toolmaker-Noir"\n')
    assert load(path).theme == "toolmaker-noir"
    named = _write(tmp_path / "named.toml", 'admin_password = "pw"\ntheme = "GitHub Light"\n')
    assert load(named).theme == "github-light"
    assert Config().theme == "toolmaker-noir"


def test_unknown_theme_falls_back_to_the_default_with_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = _write(tmp_path / "config.toml", 'admin_password = "pw"\ntheme = "My-Custom"\n')
    with caplog.at_level(logging.WARNING, logger="r1cord_server.config"):
        cfg = load(path)
    assert cfg.theme == "toolmaker-noir"
    assert any("My-Custom" in r.getMessage() for r in caplog.records if r.name == "r1cord_server.config")


def test_with_updates_takes_a_theme_by_name_or_id_and_refuses_an_unknown_one() -> None:
    assert with_updates(Config(), theme="High Contrast").theme == "high-contrast"
    assert with_updates(Config(), theme="altuit-toc").theme == "altuit-toc"
    with pytest.raises(ValueError):
        with_updates(Config(), theme="nope")
