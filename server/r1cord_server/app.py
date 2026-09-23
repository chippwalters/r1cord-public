"""FastAPI application factory. Starts the worker on startup, stops it on shutdown."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .admin import router as admin_router
from .api import router as api_router
from .config import Config
from .pipeline.publish import Republisher
from .store import JobStore
from .usb import UsbWatcher
from .worker import Worker

PACKAGE_DIR = Path(__file__).resolve().parent
log = logging.getLogger("r1cord_server.app")


def _log_handled(request: Request, status_code: int, code: str, detail: str = "") -> None:
    """One line per handled error: method, path (no query string), status, machine code, and the
    error body's message when it names the reason (e.g. "missing bearer token").

    4xx are expected client mistakes (INFO); 5xx are ours (WARNING). Never header values.
    """
    log.log(
        logging.WARNING if status_code >= 500 else logging.INFO,
        "%s %s -> %s %s%s",
        request.method,
        request.url.path,
        status_code,
        code,
        f" | {detail}" if detail else "",
    )


def _setup_logging(config: Config) -> None:
    log_dir = Path(config.datastore) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("r1cord_server")
    if logger.handlers:
        return
    handler = logging.FileHandler(log_dir / "server.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def create_app(config: Config, config_path: Path | None = None) -> FastAPI:
    config_path = config_path or Path(config.datastore) / "config.toml"
    # Edited AI review prompts live beside config.toml as prompts/<kind>.md.
    prompts_dir = config_path.parent / "prompts"
    store = JobStore(config)
    worker = Worker(store, config, prompts_dir=prompts_dir)
    usb = UsbWatcher(
        store,
        lambda: app.state.config,
        request_exit=lambda: app.state.request_exit(),
        last_activity=lambda: app.state.last_activity,
        open_dashboard=lambda: app.state.open_dashboard(),
    )
    _setup_logging(config)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        worker.start()
        usb.start()
        yield
        usb.stop()
        worker.stop()

    app = FastAPI(
        title="r1cord-server",
        lifespan=lifespan,
        redirect_slashes=False,
    )
    app.state.config = config
    app.state.store = store
    app.state.worker = worker
    app.state.usb = usb
    app.state.config_path = config_path
    app.state.prompts_dir = prompts_dir
    # Settings > Pages > Republish all pages runs on its own thread; the last run's results live here.
    app.state.republish = Republisher()
    app.state.last_activity = time.monotonic()
    # __main__ replaces this with uvicorn's should_exit; under an embedded/test app it is a no-op.
    app.state.request_exit = lambda: None
    app.state.open_dashboard = lambda: None

    app.include_router(api_router, prefix="/v1")
    app.include_router(admin_router)

    static_dir = PACKAGE_DIR / "static"
    if static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.middleware("http")
    async def no_store(request: Request, call_next):
        # Everything here is per-device state; keep Cloudflare and browsers from caching any of it.
        app.state.last_activity = time.monotonic()
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        parts: list[str] = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", ()) if x != "body")
            msg = str(err.get("msg", "invalid"))
            parts.append(f"{loc}: {msg}" if loc else msg)
        message = "; ".join(parts) or "invalid request"
        _log_handled(request, 422, "invalid_request")
        return JSONResponse(
            status_code=422,
            content={"error": "invalid_request", "message": message},
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        headers = dict(exc.headers) if exc.headers else None
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            body = dict(exc.detail)
            body.setdefault("message", "")
            _log_handled(request, exc.status_code, str(body["error"]))
            return JSONResponse(status_code=exc.status_code, content=body, headers=headers)
        code = "unauthorized" if exc.status_code == 401 else "http_error"
        if exc.status_code == 404:
            code = "not_found"
        _log_handled(request, exc.status_code, code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": code, "message": str(exc.detail)},
            headers=headers,
        )

    @app.exception_handler(HTTPException)
    async def fastapi_http_handler(request: Request, exc: HTTPException) -> JSONResponse:
        headers = dict(exc.headers) if exc.headers else None
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            body = dict(exc.detail)
            body.setdefault("message", "")
            _log_handled(request, exc.status_code, str(body["error"]), str(body["message"]))
            return JSONResponse(status_code=exc.status_code, content=body, headers=headers)
        code = "unauthorized" if exc.status_code == 401 else "http_error"
        _log_handled(request, exc.status_code, code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": code, "message": str(exc.detail)},
            headers=headers,
        )

    return app
