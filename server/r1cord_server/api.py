""" /v1 routes — wire contract offload-api-v1.md is authoritative. """

from __future__ import annotations

import re
from typing import Any, Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .auth import require_token
from .store import (
    STYLES,
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
    summarize: bool = True
    publish: bool = True
    summaryStyle: str = "notes"
    files: list[FileIn]


class CreateJobBody(BaseModel):
    job: JobIn
    metadata: dict[str, Any] = Field(default_factory=dict)


class PairBody(BaseModel):
    code: str


class RetryWriterBody(BaseModel):
    writer: str | None = None


def _error(status: int, error: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": error, "message": message, **extra},
    )


def _validate_job_in(job: JobIn) -> str | None:
    title = job.title.strip()
    if not title or len(title) > 120:
        return "title must be 1–120 characters after trim"
    if job.summaryStyle not in STYLES:
        return "summaryStyle must be notes, minutes, or article"
    if not job.recordingId or any(c in job.recordingId for c in "/\\"):
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
def pair(body: PairBody, request: Request) -> JSONResponse:
    code = body.code.strip()
    token = request.app.state.store.redeem_pair_code(code, label="device")
    if token is None:
        return _error(400, "invalid_code", "unknown, used, or expired pairing code")
    return JSONResponse(
        status_code=200,
        content={"token": token, "serverName": request.app.state.config.server_name},
    )


@router.post("/jobs", dependencies=[Depends(require_token)])
def create_job(body: CreateJobBody, request: Request) -> JSONResponse:
    problem = _validate_job_in(body.job)
    if problem:
        return _error(422, "invalid_request", problem)
    job = body.job
    req = JobRequest(
        recording_id=job.recordingId,
        created_at_ms=int(job.createdAt),
        title=job.title.strip(),
        summarize=bool(job.summarize),
        publish=bool(job.publish),
        summary_style=job.summaryStyle,
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
        return _error(409, "job_active", "a job is already active for this recording", jobId=exc.job_id)
    except AudioMismatch:
        return _error(409, "audio_mismatch", "audio already stored for this recording with a different hash")
    except ValueError as exc:
        return _error(422, "invalid_request", str(exc))
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
def file_received(job_id: str, name: str, request: Request) -> JSONResponse:
    """Resume point. A GET with a JSON body rather than HEAD on the file path: Cloudflare
    rewrites HEAD to GET for paths ending in cacheable extensions such as .jpg."""
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    received = store.file_received(job_id, name)
    if received is None:
        return _error(404, "not_found", f"{name} is not in the job manifest")
    return JSONResponse(status_code=200, content={"received": received})


@router.put("/jobs/{job_id}/files/{name}", dependencies=[Depends(require_token)])
async def put_file(
    job_id: str,
    name: str,
    request: Request,
    offset: Annotated[int, Query()] = 0,
) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    received = store.file_received(job_id, name)
    if received is None:
        return _error(404, "not_found", f"{name} is not in the job manifest")
    try:
        new_len = await store.append_file_async(job_id, name, offset, request.stream())
    except JobNotUploading:
        return _error(409, "job_not_uploading", "job is past the uploading state")
    except OffsetMismatch as exc:
        return _error(
            409,
            "offset_mismatch",
            f"offset must equal received length {exc.received}",
            received=exc.received,
        )
    except TooLarge as exc:
        return _error(413, "too_large", f"body would exceed manifest size {exc.size}")
    except UnknownJob:
        return _error(404, "not_found", f"unknown job or file {job_id}/{name}")
    return JSONResponse(status_code=200, content={"received": new_len})


@router.post("/jobs/{job_id}/commit", dependencies=[Depends(require_token)])
def commit_job(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    try:
        rec = store.commit(job_id)
    except Incomplete as exc:
        return _error(409, "incomplete", "one or more files are short", files=exc.files)
    except HashMismatch as exc:
        return _error(422, "hash_mismatch", "sha256 did not match the manifest", files=exc.files)
    except UnknownJob:
        return _error(404, "not_found", f"unknown job {job_id}")
    webdav = rec.webdav_url if rec.publish else None
    return JSONResponse(
        status_code=200,
        content={"jobId": rec.job_id, "status": rec.status, "webdavUrl": webdav},
    )


@router.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
def get_job(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    return JSONResponse(status_code=200, content=store.result_json(job_id))


@router.get("/recordings", dependencies=[Depends(require_token)])
def list_recordings(request: Request) -> JSONResponse:
    items = [
        {
            "recordingId": s.recording_id,
            "jobId": s.job_id,
            "status": s.status,
            "webdavUrl": s.webdav_url,
            "updatedAt": s.updated_at,
        }
        for s in request.app.state.store.recordings_index()
    ]
    return JSONResponse(status_code=200, content=items)


@router.get("/recordings/{recording_id}", dependencies=[Depends(require_token)])
def get_recording(recording_id: str, request: Request) -> JSONResponse:
    rec = request.app.state.store.latest_for(recording_id)
    if rec is None:
        return _error(404, "not_found", f"no job for recording {recording_id}")
    return JSONResponse(status_code=200, content=request.app.state.store.result_json(rec.job_id))


@router.post("/jobs/{job_id}/retry-writer", dependencies=[Depends(require_token)])
async def retry_writer(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    writer: str | None = None
    if request.headers.get("content-type", "").startswith("application/json"):
        raw = await request.body()
        if raw:
            payload = RetryWriterBody.model_validate_json(raw)
            writer = payload.writer
    if writer is not None and writer not in WRITERS:
        return _error(422, "invalid_request", f"invalid writer: {writer}")
    try:
        rec = store.retry_writer(job_id, writer)
    except RetryNotAllowed as exc:
        return _error(409, "retry_not_allowed", str(exc))
    return JSONResponse(status_code=200, content={"status": rec.status})


@router.post("/jobs/{job_id}/retry-publish", dependencies=[Depends(require_token)])
def retry_publish(job_id: str, request: Request) -> JSONResponse:
    store = request.app.state.store
    rec = store.job(job_id)
    if rec is None:
        return _error(404, "not_found", f"unknown job {job_id}")
    try:
        rec = store.retry_publish(job_id)
    except RetryNotAllowed as exc:
        return _error(409, "retry_not_allowed", str(exc))
    return JSONResponse(status_code=200, content={"status": rec.status})
