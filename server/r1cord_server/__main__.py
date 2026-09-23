"""python -m r1cord_server [--config PATH] [--port N]"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

import uvicorn

from .app import create_app
from .config import default_config_path, load


def _ensure_stdio(datastore: Path) -> None:
    """Under pythonw (no console) stdout/stderr are None and uvicorn's logging fails; log to a file instead."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = datastore / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stream = open(log_dir / "console.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - lives for the process
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="r1cord_server", description="R1CORD desktop offload server")
    parser.add_argument("--config", type=Path, default=None, help="path to config.toml")
    parser.add_argument("--port", type=int, default=None, help="listen port (overrides config)")
    args = parser.parse_args(argv)

    config = load(args.config)
    if args.port is not None:
        config = replace(config, listen_port=args.port)
    _ensure_stdio(Path(config.datastore))
    app = create_app(config, config_path=args.config or default_config_path())
    server = uvicorn.Server(
        uvicorn.Config(app, host=config.listen_host, port=config.listen_port, log_level="info")
    )
    # Lets the USB watcher stop the process in run_mode=plug once nothing needs it.
    app.state.request_exit = lambda: setattr(server, "should_exit", True)
    server.run()


if __name__ == "__main__":
    main()
