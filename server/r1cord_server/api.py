""" /v1 routes — wire contract offload-api-v1.md is authoritative. """

from __future__ import annotations

import functools
import inspect
import json
import logging
import re
from typing import Any, Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import require_token
from .config import canonical_reviews
from .store import (
    WRITERS,
    AudioMismatch,
    FileSpec,
    HashMismatch,
    Incomplete,
    JobActive,
    JobNotUploading,
    JobRequest,
    OffsetMismatch,
    RetryNotAllowed,
    TooLarge,
    UnknownJob,
)

router = APIRouter()

log = logging.getLogger("r1cord_server.api")

# Client mistakes the server expects on a healthy link (resume races, typos, expired codes);
# every other 4xx/5xx is our problem and is logged at WARNING.
_EXPECTED_STATUS = frozenset({400, 401, 404, 409})

_FILE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_PHOTO_RE = re.compile(r"^photo-[A-Za-z0-9._-]+\.jpg$")
_AUDIO = frozenset({"audio.m4a", "audio.wav"})
_SHA = re.compile(r"^[0-9a-fA-F]{64}$")


class FileIn(BaseModel):
    name: str
    size: int
    sha256: str


class JobIn(BaseModel):
    schemaVersion: int = 1
    recordingId: str
    createdAt: int
    title: str
    # `reviews` wins when present. Without it (apps up to 0.3.2) `summarize` picks ["summary"] or [];
    # `summaryStyle` is accepted and ignored.
    reviews: list[str] | None = None
    summarize: bool = True
    publish: bool = True
    summaryStyle: str | None = None
    files: list[FileIn]

    def requested_reviews(self) -> tuple[str, ...]:
        if self.reviews is None:
            return ("summary",) if self.summarize else ()
        return canonical_reviews(self.reviews)


class CreateJobBody(BaseModel):
    job: JobIn
    metadata: dict[str, Any] = Field(default_factory=dict)


class PairBody(BaseModel):
    code: str


class RetryWriterBody(BaseModel):
    writer: str | None = None
    reviews: list[str] | None = None


def _error(
    request: Request,
    status: int,
    error: str,
    message: str,
    extra: dict[str, Any] | None = None,
    log_detail: str = "",
) -> JSONResponse:
    """The one error funnel for /v1: a JSON body with a stable machine code plus one log line
    carrying route, status, code and ids. Never log request headers — the bearer token lives there."""
    extra = extra or {}
    level = logging.INFO if status in _EXPECTED_STATUS else logging.WARNING
    parts = [f"{request.method} {request.url.path} -> {status} {error}"]
    if extra:
        parts.append(json.dumps(extra, default=str))
    parts.append(message)
    if log_detail:
        parts.append(log_detail)
    log.log(level, "%s", " | ".join(parts))
    return JSONResponse(status_code=status, content={"error": error, "message": message, **extra})


def _crash(args: tuple, kw: dict, endpoint_name: str, exc: Exception) -> JSONResponse:
    """An unexpected exception: one WARNING record with the traceback, JSON 500 on the wire."""
    request = next((a for a in (*args, *kw.values()) if isinstance(a, Request)), None)
    where = f"{request.method} {request.url.path}" if request is not None else endpoint_name
    log.warning("%s -> 500 internal_error | %s: %s", where, type(exc).__name__, exc, exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "message": "unexpected server error"},
    )


def _guarded(endpoint):
    """Keep the wire contract even when a handler crashes: JSON 500 + internal_error, logged once."""

    if inspect.iscoroutinefunction(endpoint):

        @functools.wraps(endpoint)
        async def async_guarded(*args: Any, **kw: Any):
            try:
                return await endpoint(*args, **kw)
            except StarletteHTTPException:
                raise
            except Exception as exc:
                return _crash(args, kw, endpoint.__name__, exc)

        return async_guarded

    @functools.wraps(endpoint)
    def guarded(*args: Any, **kw: Any):
        try:
            return endpoint(*args, **kw)
        except StarletteHTTPException:
            raise
        except Exception as exc:
            return _crash(args, kw, endpoint.__name__, exc)

    return guarded


def _validate_job_in(job: JobIn) -> str | None:
    if job.schemaVersion != 1:
        return f"unsupported schemaVersion: {job.schemaVersion} (expected 1)"
    title = job.title.strip()
    if not title or len(title) > 120:
        return "title must be 1–120 characters after trim"
    # Mirrors store._check_recording_id: ids become folder names, so refuse escapes and
    # anything Windows would normalize (".", "..", separators, NUL, surrounding whitespace).
    if (
        not job.recordingId
        or job.recordingId in (".", "..")
        or "/" in job.recordingId
        or "\\" in job.recordingId
        or "\x00" in job.recordingId
        or job.recordingId != job.recordingId.strip()
    ):
        return "invalid recordingId"
    if not job.files:
        return "files manifest is empty"
    audio = 0
    seen: set[str] = set()
    for spec in job.files:
        if spec.name in seen:
            return f"duplicate file name: {spec.name}"
        seen.add(spec.name)
        if not _FILE_NAME_RE.fullmatch(spec.name):
            return f"invalid file name: {spec.name}"
        if spec.name in _AUDIO:
            audio += 1
        elif not _PHOTO_RE.fullmatch(spec.name):
            return f"file name not allowed: {spec.name}"
        if spec.size < 0:
            return f"invalid size for {spec.name}"
        if not _SHA.fullmatch(spec.sha256):
            return f"invalid sha256 for {spec.name}"
    if audio != 1:
        return "manifest must contain exactly one audio.m4a or audio.wav"
    return None


@router.post("/pair")
@_guarded
def pair(body: PairBody, request: Request) -> JSONResponse:
    code = body.code.strip()
    token = request.app.state.store.redeem_pair_code(code, label="device")
    if token is None:
        return _error(request, 400, "invalid_code", "unknown, used, or expired pairing code")
    return JSONResponse(
        status_code=200,
        content={"token": token, "serverName": request.app.state.config.server_name},
    )


@router.post("/jobs", dependencies=[Depends(require_token)])
@_guarded
def create_job(body: CreateJobBody, request: Request) -> JSONResponse:
    try:
        reviews = body.job.requested_reviews()
    except ValueError as exc:
        return _error(request, 400, "invalid_request", str(exc))
    problem = _validate_job_in(body.job)
    if problem:
        return _error(request, 422, "invalid_request", problem)
    job = body.job
    req = JobRequest(
        recording_id=job.recordingId,
        created_at_ms=int(job.createdAt),
        title=job.title.strip(),
        reviews=reviews,
        publish=bool(job.publish),
        files=tuple(
            FileSpec(name=f.name, size=int(f.size), sha256=f.sha256.lower())
            for f in job.files
        ),
        schema_version=int(job.schemaVersion),
    )
    store = request.app.state.store
    try:
        rec = store.create_job(req, body.metadata)
    except JobActive as exc:
        return _error(
            request,
            409,
            "job_active",
            "a job is already active for this recording",
            extra={"jobId": exc.job_id},
        )
    except AudioMismatch:
        return _error(
            request, 409, "audio_mismatch", "audio already stored for this recording with a different hash"
        )
    except ValueError as exc:
        return _error(request, 422, "invalid_request", str(exc))
    webdav = rec.webdav_url if rec.publish else None
    return JSONResponse(
        status_code=202,
        content={
            "jobId": rec.job_id,
            "recordingId": rec.recording_id,
            "status": rec.status,
            "webdavUrl": webdav,
        },
    )


@router.get("/jobs/{job_id}/files/{name}/received", dependencies=[Depends(require_token)])
@_guarded
def file_received(job_id: str, name: str, request: Request) -> JSONResponse:
    """Resume point. A GET with a JSON body rather than HEAD on the file path: Cloudflare
    rewrites HEAD to GET for paths ending in cacheable extensions such as .jpg."""
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    received = store.file_received(job_id, name)
    if received is None:
        return _error(request, 404, "not_found", f"{name} is not in the job manifest")
    return JSONResponse(status_code=200, content={"received": received})


@router.put("/jobs/{job_id}/files/{name}", dependencies=[Depends(require_token)])
@_guarded
async def put_file(
    job_id: str,
    name: str,
    request: Request,
    offset: Annotated[int, Query()] = 0,
) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    received = store.file_received(job_id, name)
    if received is None:
        return _error(request, 404, "not_found", f"{name} is not in the job manifest")
    try:
        new_len = await store.append_file_async(job_id, name, offset, request.stream())
    except JobNotUploading:
        return _error(request, 409, "job_not_uploading", "job is past the uploading state")
    except OffsetMismatch as exc:
        return _error(
            request,
            409,
            "offset_mismatch",
            f"offset must equal received length {exc.received}",
            extra={"received": exc.received},
        )
    except TooLarge as exc:
        return _error(request, 413, "too_large", f"body would exceed manifest size {exc.size}")
    except UnknownJob:
        return _error(request, 404, "not_found", f"unknown job or file {job_id}/{name}")
    return JSONResponse(status_code=200, content={"received": new_len})


@router.post("/jobs/{job_id}/commit", dependencies=[Depends(require_token)])
@_guarded
def commit_job(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    try:
        rec = store.commit(job_id)
    except Incomplete as exc:
        return _error(request, 409, "incomplete", "one or more files are short", extra={"files": exc.files})
    except HashMismatch as exc:
        return _error(request, 422, "hash_mismatch", "sha256 did not match the manifest", extra={"files": exc.files})
    except UnknownJob:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    webdav = rec.webdav_url if rec.publish else None
    return JSONResponse(
        status_code=200,
        content={"jobId": rec.job_id, "status": rec.status, "webdavUrl": webdav},
    )


@router.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
@_guarded
def get_job(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    return JSONResponse(status_code=200, content=store.result_json(job_id))


@router.get("/recordings", dependencies=[Depends(require_token)])
@_guarded
def list_recordings(request: Request) -> JSONResponse:
    items = [
        {
            "recordingId": s.recording_id,
            "jobId": s.job_id,
            "status": s.status,
            "webdavUrl": s.webdav_url,
            "pages": s.pages,
            "updatedAt": s.updated_at,
        }
        for s in request.app.state.store.recordings_index()
    ]
    return JSONResponse(status_code=200, content=items)


@router.get("/recordings/{recording_id}", dependencies=[Depends(require_token)])
@_guarded
def get_recording(recording_id: str, request: Request) -> JSONResponse:
    rec = request.app.state.store.latest_for(recording_id)
    if rec is None:
        return _error(request, 404, "not_found", f"no job for recording {recording_id}")
    return JSONResponse(status_code=200, content=request.app.state.store.result_json(rec.job_id))


@router.post("/jobs/{job_id}/retry-writer", dependencies=[Depends(require_token)])
@_guarded
async def retry_writer(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    writer: str | None = None
    reviews: tuple[str, ...] | None = None
    if request.headers.get("content-type", "").startswith("application/json"):
        raw = await request.body()
        if raw:
            try:
                payload = RetryWriterBody.model_validate_json(raw)
            except ValidationError:
                return _error(
                    request,
                    422,
                    "invalid_request",
                    'retry body must be {"writer": "claude_code" | "codex" | "grok_build", '
                    '"reviews": ["summary" | "outline" | "organized", ...]}',
                )
            writer = payload.writer
            if payload.reviews is not None:
                try:
                    reviews = canonical_reviews(payload.reviews)
                except ValueError as exc:
                    return _error(request, 422, "invalid_request", str(exc))
                if not reviews:
                    return _error(request, 422, "invalid_request", "reviews must name at least one review")
    if writer is not None and writer not in WRITERS:
        return _error(request, 422, "invalid_request", f"invalid writer: {writer}")
    try:
        rec = store.retry_writer(job_id, writer, reviews)
    except RetryNotAllowed as exc:
        return _error(request, 409, "retry_not_allowed", str(exc))
    return JSONResponse(status_code=200, content={"status": rec.status})


@router.post("/jobs/{job_id}/retry-publish", dependencies=[Depends(require_token)])
@_guarded
def retry_publish(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(request, 404, "not_found", f"unknown job {job_id}")
    try:
        rec = store.retry_publish(job_id)
    except RetryNotAllowed as exc:
        return _error(request, 409, "retry_not_allowed", str(exc))
    return JSONResponse(status_code=200, content={"status": rec.status})
