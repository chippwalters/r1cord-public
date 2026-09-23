"""SQLite job index plus datastore folders. All SQL stays in this module."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import shutil
import sqlite3
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import REVIEW_KINDS, Config, canonical_reviews
from . import naming

SCHEMA_VERSION = 1
_log = logging.getLogger(__name__)
ACTIVE_STATUSES = (
    "uploading",
    "queued",
    "transcribing",
    "transcribed",
    "writing",
    "written",
    "publishing",
    "published",
)
TERMINAL_STATUSES = ("complete", "error")
RETRY_WRITER_STATUSES = ("transcribed", "written", "published", "complete", "error")
AUDIO_NAMES = frozenset({"audio.m4a", "audio.wav"})
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PHOTO_RE = re.compile(r"^photo-[A-Za-z0-9._-]+\.jpg$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
WRITERS = frozenset({"claude_code", "codex", "grok_build", "none"})
PROCESS_ACTIONS = frozenset({"transcribe", "review", "publish"})

def _check_recording_id(recording_id: str) -> None:
    """Recording ids become folder names under inbox/ and outbox/.

    Refuse anything that could escape those roots ("..", separators) or that
    Windows would normalize into a different name (surrounding whitespace).
    """
    if (
        not recording_id
        or recording_id in (".", "..")
        or "/" in recording_id
        or "\\" in recording_id
        or "\x00" in recording_id
        or recording_id != recording_id.strip()
    ):
        raise ValueError(f"invalid recordingId: {recording_id!r}")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    sha256 TEXT UNIQUE,
    label TEXT,
    created_at TEXT,
    last_used_at TEXT,
    revoked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_codes (
    code TEXT PRIMARY KEY,
    expires_at TEXT,
    used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    recording_id TEXT,
    status TEXT,
    error TEXT,
    title TEXT,
    reviews TEXT NOT NULL DEFAULT '',
    publish INTEGER,
    writer TEXT,
    publish_folder TEXT,
    skip_asr INTEGER DEFAULT 0,
    only_publish INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    finished_at TEXT,
    asr_json TEXT,
    timings_json TEXT
);
CREATE TABLE IF NOT EXISTS job_files (
    job_id TEXT,
    name TEXT,
    size INTEGER,
    sha256 TEXT,
    received INTEGER DEFAULT 0,
    PRIMARY KEY (job_id, name)
);
CREATE TABLE IF NOT EXISTS devices (
    serial TEXT PRIMARY KEY,
    model TEXT,
    adopted_at TEXT,
    last_seen_at TEXT,
    last_sync_at TEXT,
    last_error TEXT
);
CREATE TABLE IF NOT EXISTS device_recordings (
    serial TEXT,
    recording_id TEXT,
    device_status TEXT,
    title TEXT,
    created_at_ms INTEGER,
    first_seen_at TEXT,
    pulled_at TEXT,
    auto_job_id TEXT,
    changed_since_job INTEGER DEFAULT 0,
    flag TEXT,
    PRIMARY KEY (serial, recording_id)
);
CREATE TABLE IF NOT EXISTS device_files (
    serial TEXT,
    recording_id TEXT,
    name TEXT,
    size INTEGER,
    mtime INTEGER,
    sha256 TEXT,
    pulled_at TEXT,
    PRIMARY KEY (serial, recording_id, name)
);
-- Recordings deleted on the admin page. The USB watcher never pulls these again; an explicit
-- Send or Import (create_job) clears the mark.
CREATE TABLE IF NOT EXISTS deleted_recordings (
    recording_id TEXT PRIMARY KEY,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_recording ON jobs (recording_id);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at);
"""


class StoreError(Exception):
    """Base store error."""


class JobActive(StoreError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"job already active: {job_id}")
        self.job_id = job_id


class AudioMismatch(StoreError):
    def __init__(self, recording_id: str) -> None:
        super().__init__(f"audio hash mismatch for recording {recording_id}")
        self.recording_id = recording_id


class OffsetMismatch(StoreError):
    def __init__(self, received: int) -> None:
        super().__init__(f"offset mismatch: received {received}")
        self.received = received


class TooLarge(StoreError):
    def __init__(self, size: int) -> None:
        super().__init__(f"body would exceed manifest size {size}")
        self.size = size


class Incomplete(StoreError):
    def __init__(self, files: list[dict[str, Any]]) -> None:
        super().__init__("upload incomplete")
        self.files = files


class HashMismatch(StoreError):
    def __init__(self, files: list[str]) -> None:
        super().__init__(f"hash mismatch: {files}")
        self.files = files


class JobNotUploading(StoreError):
    def __init__(self, job_id: str, status: str) -> None:
        super().__init__(f"job {job_id} is {status}, not uploading")
        self.job_id = job_id
        self.status = status


class RetryNotAllowed(StoreError):
    pass


class UnknownJob(StoreError):
    def __init__(self, job_id: str) -> None:
        super().__init__(f"unknown job {job_id}")
        self.job_id = job_id


@dataclass(frozen=True)
class FileSpec:
    name: str
    size: int
    sha256: str


@dataclass(frozen=True)
class JobRequest:
    recording_id: str
    created_at_ms: int
    title: str
    reviews: tuple[str, ...]
    publish: bool
    files: tuple[FileSpec, ...]
    schema_version: int = SCHEMA_VERSION
    writer: str | None = None


@dataclass
class JobRecord:
    job_id: str
    recording_id: str
    status: str
    error: str | None
    title: str
    reviews: tuple[str, ...]
    publish: bool
    writer: str
    # Predicted URL for older clients: summary.html when a summary is requested, else transcript.html.
    webdav_url: str | None
    publish_folder: str | None
    skip_asr: bool
    only_publish: bool
    created_at: str
    updated_at: str
    finished_at: str | None
    asr: dict[str, Any] | None
    timings: dict[str, int]
    created_at_ms: int = 0
    files: list[FileSpec] = field(default_factory=list)


@dataclass(frozen=True)
class TokenInfo:
    id: int
    sha256: str
    label: str
    created_at: str
    last_used_at: str | None
    revoked: bool


@dataclass(frozen=True)
class RecordingSummary:
    recording_id: str
    job_id: str
    status: str
    webdav_url: str | None
    pages: list[dict[str, str]]
    updated_at: str


@dataclass(frozen=True)
class DeviceInfo:
    serial: str
    model: str
    adopted: bool
    adopted_at: str | None
    last_seen_at: str | None
    last_sync_at: str | None
    last_error: str | None


@dataclass(frozen=True)
class DeviceRecording:
    serial: str
    recording_id: str
    device_status: str
    title: str
    created_at_ms: int
    first_seen_at: str
    pulled_at: str | None
    auto_job_id: str | None
    changed_since_job: bool
    flag: str | None
    file_count: int
    bytes: int
    latest_job: JobRecord | None


def _split_reviews(value: Any) -> tuple[str, ...]:
    """The `reviews` column: canonical kinds joined by commas; '' for transcript only."""
    return tuple(k for k in str(value or "").split(",") if k in REVIEW_KINDS)


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ms_to_iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _iso_to_ms(value: str) -> int:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


class JobStore:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._lock = threading.RLock()
        root = Path(config.datastore)
        for name in ("inbox", "work", "outbox", "logs"):
            (root / name).mkdir(parents=True, exist_ok=True)
        self._db_path = root / "index.sqlite"
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_SCHEMA)
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        """Bring a database from before AI reviews up to date: `summarize` becomes `reviews`,
        and the summary style and the stored URL (now derived from the publish folder) go."""
        columns = {str(r["name"]) for r in self._conn.execute("PRAGMA table_info(jobs)")}
        if "reviews" not in columns:
            self._conn.execute("ALTER TABLE jobs ADD COLUMN reviews TEXT NOT NULL DEFAULT ''")
            if "summarize" in columns:
                self._conn.execute(
                    "UPDATE jobs SET reviews = CASE WHEN summarize = 1 THEN 'summary' ELSE '' END"
                )
            _log.info("store: migrated jobs to AI reviews")
        for column in ("summarize", "summary_style", "webdav_url"):
            if column in columns:
                self._conn.execute(f"ALTER TABLE jobs DROP COLUMN {column}")

    # --- paths -------------------------------------------------------------

    def inbox_dir(self, recording_id: str) -> Path:
        _check_recording_id(recording_id)
        path = Path(self.config.datastore) / "inbox" / recording_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def work_dir(self, job_id: str) -> Path:
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        path = Path(self.config.datastore) / "work" / rec.recording_id / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def outbox_dir(self, recording_id: str) -> Path:
        _check_recording_id(recording_id)
        path = Path(self.config.datastore) / "outbox" / recording_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    # --- auth --------------------------------------------------------------

    def create_pair_code(self) -> str:
        expires = datetime.now(timezone.utc) + timedelta(seconds=self.config.pair_code_ttl_s)
        expires_at = expires.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        with self._lock:
            for _ in range(20):
                code = f"{secrets.randbelow(1_000_000):06d}"
                try:
                    self._conn.execute(
                        "INSERT INTO pair_codes (code, expires_at, used) VALUES (?, ?, 0)",
                        (code, expires_at),
                    )
                    self._conn.commit()
                    return code
                except sqlite3.IntegrityError:
                    continue
        _log.warning("store: could not allocate a pairing code after 20 attempts")
        raise StoreError("could not allocate a pairing code")

    def redeem_pair_code(self, code: str, label: str) -> str | None:
        now = utcnow_iso()
        with self._lock:
            row = self._conn.execute(
                "SELECT code, expires_at, used FROM pair_codes WHERE code = ?",
                (code,),
            ).fetchone()
            if row is None or int(row["used"]) != 0 or str(row["expires_at"]) < now:
                return None
            raw = secrets.token_hex(32)
            digest = hash_token(raw)
            self._conn.execute("UPDATE pair_codes SET used = 1 WHERE code = ?", (code,))
            self._conn.execute(
                "INSERT INTO tokens (sha256, label, created_at, last_used_at, revoked) "
                "VALUES (?, ?, ?, NULL, 0)",
                (digest, label, now),
            )
            self._conn.commit()
            return raw

    def token_valid(self, raw_token: str) -> bool:
        digest = hash_token(raw_token)
        dummy = "0" * 64
        with self._lock:
            row = self._conn.execute(
                "SELECT id, sha256, revoked FROM tokens WHERE sha256 = ?",
                (digest,),
            ).fetchone()
            if row is None or int(row["revoked"]) != 0:
                hmac.compare_digest(digest, dummy)
                return False
            if not hmac.compare_digest(str(row["sha256"]), digest):
                return False
            self._conn.execute(
                "UPDATE tokens SET last_used_at = ? WHERE id = ?",
                (utcnow_iso(), int(row["id"])),
            )
            self._conn.commit()
            return True

    def tokens(self) -> list[TokenInfo]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, sha256, label, created_at, last_used_at, revoked "
                "FROM tokens ORDER BY id DESC"
            ).fetchall()
        return [
            TokenInfo(
                id=int(r["id"]),
                sha256=str(r["sha256"]),
                label=str(r["label"] or ""),
                created_at=str(r["created_at"]),
                last_used_at=str(r["last_used_at"]) if r["last_used_at"] else None,
                revoked=bool(int(r["revoked"])),
            )
            for r in rows
        ]

    def revoke_token(self, token_id: int) -> None:
        with self._lock:
            self._conn.execute("UPDATE tokens SET revoked = 1 WHERE id = ?", (token_id,))
            self._conn.commit()

    # --- jobs --------------------------------------------------------------

    def create_job(self, job: JobRequest, metadata: dict[str, Any]) -> JobRecord:
        self._validate_request(job)
        reviews = canonical_reviews(job.reviews)
        with self._lock:
            active = self.active_job_for(job.recording_id)
            if active is not None:
                raise JobActive(active.job_id)

            inbox = self.inbox_dir(job.recording_id)
            self._check_audio_mismatch(inbox, job)

            writer = job.writer or self.config.default_writer
            if writer not in WRITERS:
                raise ValueError(f"invalid writer: {writer}")

            existing = self.latest_for(job.recording_id)
            if existing and existing.publish_folder:
                publish_path = Path(existing.publish_folder)
            else:
                occupied = self._occupied_folders()
                publish_path = naming.publish_folder(
                    self.config,
                    job.created_at_ms,
                    job.title,
                    job.recording_id,
                    occupied=occupied,
                )

            now = utcnow_iso()
            job_id = str(uuid4())
            created_iso = ms_to_iso(job.created_at_ms)
            title = job.title.strip()
            (inbox / "metadata.json").write_text(
                json.dumps(metadata, indent=2),
                encoding="utf-8",
            )
            self._conn.execute(
                "INSERT INTO jobs (job_id, recording_id, status, error, title, reviews, "
                "publish, writer, publish_folder, skip_asr, "
                "only_publish, created_at, updated_at, finished_at, asr_json, timings_json) "
                "VALUES (?, ?, 'uploading', NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, ?)",
                (
                    job_id,
                    job.recording_id,
                    title,
                    ",".join(reviews),
                    int(job.publish),
                    writer,
                    str(publish_path),
                    created_iso,
                    now,
                    json.dumps({"asr": 0, "writer": 0, "publish": 0}),
                ),
            )
            for spec in job.files:
                received = 0
                dest = inbox / spec.name
                if dest.is_file() and sha256_file(dest) == spec.sha256.lower() and dest.stat().st_size == spec.size:
                    received = spec.size
                self._conn.execute(
                    "INSERT INTO job_files (job_id, name, size, sha256, received) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (job_id, spec.name, spec.size, spec.sha256.lower(), received),
                )
            self._conn.execute("DELETE FROM deleted_recordings WHERE recording_id = ?", (job.recording_id,))
            self._conn.commit()
            rec = self.job(job_id)
            assert rec is not None
            self._write_result_json(rec)
            return rec

    def has_active_jobs(self) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM jobs WHERE status NOT IN ('complete', 'error') LIMIT 1"
            ).fetchone()
            return row is not None

    def latest_jobs(self, limit: int = 100) -> list[tuple[JobRecord, int]]:
        """The newest job of each recording, newest first, with that recording's job count."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM (
                    SELECT j.*,
                           ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY rowid DESC) AS rn,
                           COUNT(*) OVER (PARTITION BY recording_id) AS runs,
                           rowid AS rid
                    FROM jobs j
                ) WHERE rn = 1
                ORDER BY updated_at DESC, rid DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [(self._job_from_row(r), int(r["runs"])) for r in rows]

    def is_deleted(self, recording_id: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM deleted_recordings WHERE recording_id = ?", (recording_id,)
            ).fetchone()
            return row is not None

    def delete_recording(self, recording_id: str) -> None:
        """Remove a recording from this PC: its inbox, outbox and work folders, every published
        page it produced (only inside `webdav_folder`), its jobs and its device-ledger rows.

        Files go first: if one is locked (open in a media player), nothing in the index changes
        and the delete can simply be retried. The R1's own copy is never touched; the recording
        is marked deleted so USB mode does not pull it back.
        """
        _check_recording_id(recording_id)
        with self._lock:
            if self.active_job_for(recording_id) is not None:
                raise StoreError("a job is still running for this recording; wait for it to finish")
            folders = [
                Path(r["publish_folder"])
                for r in self._conn.execute(
                    "SELECT DISTINCT publish_folder FROM jobs WHERE recording_id = ? AND publish_folder IS NOT NULL",
                    (recording_id,),
                )
            ]
            root = Path(self.config.datastore)
            targets = [root / area / recording_id for area in ("inbox", "outbox", "work")]
            webdav = Path(self.config.webdav_folder).resolve()
            for folder in folders:
                resolved = folder.resolve()
                # Only a folder this server published into, never the publish root or anything outside it.
                if webdav in resolved.parents:
                    targets.append(resolved)
            for target in targets:
                if target.exists():
                    try:
                        shutil.rmtree(target)
                    except OSError as exc:
                        _log.warning("delete %s: could not remove %s: %s", recording_id, target, exc)
                        raise StoreError(f"could not remove {target.name}: {exc.strerror or exc}") from exc
            self._conn.execute(
                "DELETE FROM job_files WHERE job_id IN (SELECT job_id FROM jobs WHERE recording_id = ?)",
                (recording_id,),
            )
            for table in ("jobs", "device_files", "device_recordings"):
                self._conn.execute(f"DELETE FROM {table} WHERE recording_id = ?", (recording_id,))
            self._conn.execute(
                "INSERT OR REPLACE INTO deleted_recordings (recording_id, deleted_at) VALUES (?, ?)",
                (recording_id, utcnow_iso()),
            )
            self._conn.commit()
        _log.info("delete %s: removed %d folder(s) and its job history", recording_id, len(targets))

    def active_job_for(self, recording_id: str) -> JobRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE recording_id = ? AND status NOT IN ('complete', 'error') "
                "ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (recording_id,),
            ).fetchone()
            return self._job_from_row(row) if row else None

    def job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
            return self._job_from_row(row) if row else None

    def latest_for(self, recording_id: str) -> JobRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE recording_id = ? ORDER BY rowid DESC LIMIT 1",
                (recording_id,),
            ).fetchone()
            return self._job_from_row(row) if row else None

    def recordings_index(self) -> list[RecordingSummary]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT recording_id, job_id, status, reviews, publish, publish_folder, updated_at FROM (
                    SELECT j.*, ROW_NUMBER() OVER (PARTITION BY recording_id ORDER BY rowid DESC) AS rn
                    FROM jobs j
                ) WHERE rn = 1
                ORDER BY updated_at DESC
                """
            ).fetchall()
        summaries: list[RecordingSummary] = []
        for r in rows:
            folder = str(r["publish_folder"]) if r["publish_folder"] else None
            url = self._predicted_url(folder, _split_reviews(r["reviews"]))
            summaries.append(
                RecordingSummary(
                    recording_id=str(r["recording_id"]),
                    job_id=str(r["job_id"]),
                    status=str(r["status"]),
                    webdav_url=url if int(r["publish"]) else None,
                    pages=naming.published_pages(self.config, folder),
                    updated_at=str(r["updated_at"]),
                )
            )
        return summaries

    def recent_jobs(self, limit: int = 50) -> list[JobRecord]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM jobs ORDER BY updated_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [self._job_from_row(r) for r in rows]

    def next_queued(self) -> JobRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1"
            ).fetchone()
            return self._job_from_row(row) if row else None

    def recover_interrupted(self) -> list[tuple[str, str, str]]:
        """Requeue jobs a previous run left mid-pipeline; call before the worker starts.

        The worker owns a job from `transcribing` to `published`; if the server stopped in
        between, nothing else would ever move the job on and its recording would answer
        `job_active` forever. Returns `(job_id, was, now)` for each job it moved.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT job_id, recording_id, status, publish FROM jobs WHERE status IN (?, ?, ?, ?, ?, ?)",
                ("transcribing", "transcribed", "writing", "written", "publishing", "published"),
            ).fetchall()
        moved: list[tuple[str, str, str]] = []
        for row in rows:
            job_id, was = str(row["job_id"]), str(row["status"])
            has_transcript = (self.outbox_dir(str(row["recording_id"])) / "transcript.txt").is_file()
            if was == "published" or (was == "written" and not int(row["publish"])):
                self.set_status(job_id, "complete")  # the last step had finished
            elif was in ("written", "publishing"):
                self.set_status(job_id, "queued", skip_asr=True, only_publish=True)
            elif was in ("transcribed", "writing") and has_transcript:
                self.set_status(job_id, "queued", skip_asr=True, only_publish=False)
            else:
                self.set_status(job_id, "queued", skip_asr=False, only_publish=False)
            now = str(self.job(job_id).status)  # type: ignore[union-attr]
            self.append_log(job_id, f"recovered after a server restart: was {was}, now {now}")
            moved.append((job_id, was, now))
        return moved

    def set_status(
        self,
        job_id: str,
        status: str,
        *,
        error: str | None = None,
        **fields: Any,
    ) -> None:
        with self._lock:
            rec = self.job(job_id)
            if rec is None:
                raise UnknownJob(job_id)
            now = utcnow_iso()
            updates: dict[str, Any] = {"status": status, "updated_at": now}
            if status == "error":
                updates["error"] = error
                updates["finished_at"] = now
            else:
                updates["error"] = None
                if status == "complete":
                    updates["finished_at"] = now
                elif status == "queued":
                    updates["finished_at"] = None
            mapping = {
                "skip_asr": "skip_asr",
                "only_publish": "only_publish",
                "writer": "writer",
                "publish_folder": "publish_folder",
            }
            for key, column in mapping.items():
                if key in fields:
                    value = fields[key]
                    if key in ("skip_asr", "only_publish"):
                        value = int(bool(value))
                    updates[column] = value
            if "reviews" in fields:
                updates["reviews"] = ",".join(canonical_reviews(fields["reviews"]))
            if "asr" in fields:
                updates["asr_json"] = json.dumps(fields["asr"]) if fields["asr"] is not None else None
            if "timings" in fields:
                updates["timings_json"] = json.dumps(fields["timings"])
            assignments = ", ".join(f"{col} = ?" for col in updates)
            self._conn.execute(
                f"UPDATE jobs SET {assignments} WHERE job_id = ?",
                (*updates.values(), job_id),
            )
            self._conn.commit()
            rec = self.job(job_id)
            assert rec is not None
            self._write_result_json(rec)

    def append_log(self, job_id: str, line: str) -> None:
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        path = self.outbox_dir(rec.recording_id) / "job.log"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"{utcnow_iso()} {line.rstrip()}\n")

    def read_log(self, job_id: str, tail: int = 200) -> list[str]:
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        path = self.outbox_dir(rec.recording_id) / "job.log"
        if not path.is_file():
            return []
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if tail <= 0:
            return lines
        return lines[-tail:]

    def result_json(self, job_id: str) -> dict[str, Any]:
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        history: list[dict[str, Any]] = []
        with self._lock:
            rows = self._conn.execute(
                "SELECT job_id, writer, status, finished_at FROM jobs "
                "WHERE recording_id = ? ORDER BY created_at ASC, rowid ASC",
                (rec.recording_id,),
            ).fetchall()
        for row in rows:
            history.append(
                {
                    "jobId": str(row["job_id"]),
                    "writer": str(row["writer"]),
                    "status": str(row["status"]),
                    "finishedAt": str(row["finished_at"]) if row["finished_at"] else None,
                }
            )
        asr = rec.asr
        if asr is not None:
            asr_out = {
                "model": asr.get("model"),
                "device": asr.get("device"),
                "language": asr.get("language"),
            }
        else:
            asr_out = None
        return {
            "schemaVersion": SCHEMA_VERSION,
            "recordingId": rec.recording_id,
            "jobId": rec.job_id,
            "status": rec.status,
            "error": rec.error,
            "title": rec.title,
            "reviews": list(rec.reviews),
            "publish": rec.publish,
            "writer": rec.writer,
            "asr": asr_out,
            "webdavUrl": rec.webdav_url if rec.publish else None,
            "pages": self.pages(rec),
            "publishFolder": rec.publish_folder,
            "timingsMs": rec.timings or {"asr": 0, "writer": 0, "publish": 0},
            "createdAt": rec.created_at,
            "updatedAt": rec.updated_at,
            "history": history,
        }

    def previous_review_job(self, recording_id: str, kind: str, job_id: str) -> str | None:
        """The newest other job of the recording that got as far as writing `kind`: the job an
        existing `<kind>.md` most likely came from. Names the archived copy on a rewrite."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT job_id, reviews FROM jobs WHERE recording_id = ? AND job_id != ? "
                "AND status IN ('written', 'publishing', 'published', 'complete', 'error') "
                "ORDER BY rowid DESC",
                (recording_id, job_id),
            ).fetchall()
        for row in rows:
            if kind in _split_reviews(row["reviews"]):
                return str(row["job_id"])
        return None

    def pages(self, rec: JobRecord) -> list[dict[str, str]]:
        """Pages actually published for the job's recording (every job of a recording shares
        one publish folder)."""
        return naming.published_pages(self.config, rec.publish_folder)

    # --- upload ------------------------------------------------------------

    def file_received(self, job_id: str, name: str) -> int | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT received FROM job_files WHERE job_id = ? AND name = ?",
                (job_id, name),
            ).fetchone()
            if row is None:
                return None
            rec = self.job(job_id)
            if rec is None:
                return None
            partial = self.inbox_dir(rec.recording_id) / ".upload" / f"{name}.partial"
            if partial.is_file():
                return partial.stat().st_size
            return int(row["received"])

    def append_file(self, job_id: str, name: str, offset: int, body: Iterator[bytes]) -> int:
        path, size, done = self._begin_append(job_id, name, offset)
        if done:
            for chunk in body:
                if chunk:
                    raise TooLarge(size)
            return size
        assert path is not None
        received = offset
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = "wb" if offset == 0 else "r+b"
        with path.open(mode) as fh:
            if offset:
                fh.seek(offset)
            for chunk in body:
                if not chunk:
                    continue
                if received + len(chunk) > size:
                    fh.seek(offset)
                    fh.truncate()
                    raise TooLarge(size)
                fh.write(chunk)
                received += len(chunk)
        self._finish_append(job_id, name, received)
        return received

    async def append_file_async(
        self,
        job_id: str,
        name: str,
        offset: int,
        body: Any,
    ) -> int:
        path, size, done = self._begin_append(job_id, name, offset)
        if done:
            async for chunk in body:
                if chunk:
                    raise TooLarge(size)
            return size
        assert path is not None
        received = offset
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = "wb" if offset == 0 else "r+b"
        with path.open(mode) as fh:
            if offset:
                fh.seek(offset)
            async for chunk in body:
                if not chunk:
                    continue
                if received + len(chunk) > size:
                    fh.seek(offset)
                    fh.truncate()
                    raise TooLarge(size)
                fh.write(chunk)
                received += len(chunk)
        self._finish_append(job_id, name, received)
        return received

    def commit(self, job_id: str) -> JobRecord:
        with self._lock:
            rec = self.job(job_id)
            if rec is None:
                raise UnknownJob(job_id)
            if rec.status != "uploading":
                return rec
            files = self._files_for(job_id)
            inbox = self.inbox_dir(rec.recording_id)
            incomplete: list[dict[str, Any]] = []
            mismatches: list[str] = []
            for spec in files:
                partial = inbox / ".upload" / f"{spec.name}.partial"
                final = inbox / spec.name
                if partial.is_file():
                    source = partial
                elif final.is_file():
                    source = final
                else:
                    incomplete.append(
                        {"name": spec.name, "received": 0, "size": spec.size}
                    )
                    continue
                received = source.stat().st_size
                if received != spec.size:
                    incomplete.append(
                        {"name": spec.name, "received": received, "size": spec.size}
                    )
                    continue
                digest = sha256_file(source)
                if digest != spec.sha256.lower():
                    mismatches.append(spec.name)
                    if source == partial:
                        partial.unlink()
                        self._conn.execute(
                            "UPDATE job_files SET received = 0 WHERE job_id = ? AND name = ?",
                            (job_id, spec.name),
                        )
            if incomplete:
                self._conn.commit()
                raise Incomplete(incomplete)
            if mismatches:
                self._conn.commit()
                raise HashMismatch(mismatches)
            for spec in files:
                partial = inbox / ".upload" / f"{spec.name}.partial"
                final = inbox / spec.name
                if partial.is_file():
                    if final.exists():
                        final.unlink()
                    partial.replace(final)
                self._conn.execute(
                    "UPDATE job_files SET received = ? WHERE job_id = ? AND name = ?",
                    (spec.size, job_id, spec.name),
                )
            upload_dir = inbox / ".upload"
            if upload_dir.is_dir() and not any(upload_dir.iterdir()):
                upload_dir.rmdir()
            job_json = {
                "schemaVersion": SCHEMA_VERSION,
                "recordingId": rec.recording_id,
                "createdAt": rec.created_at,
                "title": rec.title,
                "reviews": list(rec.reviews),
                "publish": rec.publish,
                "files": [
                    {"name": f.name, "size": f.size, "sha256": f.sha256} for f in files
                ],
            }
            (inbox / "job.json").write_text(json.dumps(job_json, indent=2), encoding="utf-8")
            self._conn.commit()
        self.set_status(job_id, "queued")
        rec = self.job(job_id)
        assert rec is not None
        return rec

    # --- retries -----------------------------------------------------------

    def retry_writer(
        self,
        job_id: str,
        writer: str | None,
        reviews: tuple[str, ...] | list[str] | None = None,
    ) -> JobRecord:
        """Re-run the writer on the existing transcript. `reviews` defaults to the job's own;
        an explicit list must name at least one known kind (ValueError otherwise)."""
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        if reviews is not None:
            chosen_reviews = canonical_reviews(reviews)
            if not chosen_reviews:
                raise ValueError("choose at least one review")
        else:
            chosen_reviews = rec.reviews
        if rec.status not in RETRY_WRITER_STATUSES:
            raise RetryNotAllowed(f"cannot retry writer from status {rec.status}")
        transcript = self.outbox_dir(rec.recording_id) / "transcript.txt"
        if not transcript.is_file():
            raise RetryNotAllowed("transcript.txt is missing")
        if not chosen_reviews:
            raise RetryNotAllowed("this job has no AI reviews; choose at least one")
        chosen = writer or rec.writer
        if chosen not in WRITERS or chosen == "none":
            raise RetryNotAllowed(f"invalid writer: {chosen}")
        self.set_status(
            job_id,
            "queued",
            writer=chosen,
            reviews=chosen_reviews,
            skip_asr=True,
            only_publish=False,
        )
        rec = self.job(job_id)
        assert rec is not None
        return rec

    def retry_publish(self, job_id: str) -> JobRecord:
        rec = self.job(job_id)
        if rec is None:
            raise UnknownJob(job_id)
        outbox = self.outbox_dir(rec.recording_id)
        sources = ["transcript.txt", "transcript.md", *(f"{kind}.md" for kind in REVIEW_KINDS)]
        if not any((outbox / name).is_file() for name in sources):
            raise RetryNotAllowed("nothing to publish: no transcript or AI review yet")
        self.set_status(job_id, "queued", skip_asr=True, only_publish=True)
        rec = self.job(job_id)
        assert rec is not None
        return rec

    # --- import ------------------------------------------------------------

    def import_folder(
        self,
        folder: Path,
        *,
        title: str | None,
        reviews: tuple[str, ...] | list[str],
        publish: bool,
    ) -> JobRecord:
        folder = Path(folder)
        meta_path = folder / "metadata.json"
        if not meta_path.is_file():
            raise FileNotFoundError(f"no metadata.json in {folder}")
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            raise ValueError("metadata.json is not an object")
        recording_id = str(metadata.get("id") or "").strip()
        if not recording_id:
            raise ValueError("metadata.json missing id")
        _check_recording_id(recording_id)
        chosen_title = (title or str(metadata.get("title") or "")).strip()
        if not chosen_title:
            chosen_title = "recording"
        chosen_reviews = canonical_reviews(reviews)
        created_at_ms = int(metadata.get("createdAt") or 0)
        if created_at_ms <= 0:
            created_at_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

        specs: list[FileSpec] = []
        audio_files = [p for p in folder.iterdir() if p.is_file() and p.name in AUDIO_NAMES]
        if len(audio_files) != 1:
            raise ValueError("import folder must contain exactly one audio.m4a or audio.wav")
        photos = sorted(p for p in folder.iterdir() if p.is_file() and PHOTO_RE.fullmatch(p.name))
        for path in [audio_files[0], *photos]:
            specs.append(
                FileSpec(
                    name=path.name,
                    size=path.stat().st_size,
                    sha256=sha256_file(path),
                )
            )

        inbox = self.inbox_dir(recording_id)
        if folder.resolve() != inbox.resolve():
            for spec in specs:
                shutil.copy2(folder / spec.name, inbox / spec.name)
            shutil.copy2(meta_path, inbox / "metadata.json")

        req = JobRequest(
            recording_id=recording_id,
            created_at_ms=created_at_ms,
            title=chosen_title[:120],
            reviews=chosen_reviews,
            publish=publish,
            files=tuple(specs),
        )
        rec = self.create_job(req, metadata)
        return self.commit(rec.job_id)

    def process_inbox(
        self,
        recording_id: str,
        *,
        action: str,
        title: str | None = None,
    ) -> JobRecord:
        """Queue a job for a recording already sitting in inbox/ (USB pull or folder drop).

        transcribe = transcript only; review = the default AI reviews; publish = those plus publish.
        """
        if action not in PROCESS_ACTIONS:
            raise ValueError(f"invalid action: {action}")
        return self.import_folder(
            self.inbox_dir(recording_id),
            title=title,
            reviews=() if action == "transcribe" else self.config.default_reviews,
            publish=action == "publish",
        )

    def add_review(self, recording_id: str, kind: str) -> JobRecord:
        """Queue a job that writes (or rewrites) one AI review from the existing transcript.

        ASR is skipped; the job publishes when the recording's latest job did.
        """
        _check_recording_id(recording_id)
        reviews = canonical_reviews([kind])
        with self._lock:
            latest = self.latest_for(recording_id)
            if latest is None:
                raise StoreError(f"unknown recording {recording_id}")
            if self.active_job_for(recording_id) is not None:
                raise StoreError("a job is still running for this recording; wait for it to finish")
            if not (self.outbox_dir(recording_id) / "transcript.txt").is_file():
                raise StoreError("no transcript yet; transcribe the recording first")
            writer = self.config.default_writer if self.config.default_writer != "none" else latest.writer
            if writer == "none":
                raise StoreError("no writer: choose a default writer in Settings")
            now = utcnow_iso()
            job_id = str(uuid4())
            self._conn.execute(
                "INSERT INTO jobs (job_id, recording_id, status, error, title, reviews, "
                "publish, writer, publish_folder, skip_asr, "
                "only_publish, created_at, updated_at, finished_at, asr_json, timings_json) "
                "VALUES (?, ?, 'queued', NULL, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, ?, ?)",
                (
                    job_id,
                    recording_id,
                    latest.title,
                    ",".join(reviews),
                    int(latest.publish),
                    writer,
                    latest.publish_folder,
                    latest.created_at,
                    now,
                    json.dumps(latest.asr) if latest.asr is not None else None,
                    json.dumps({"asr": 0, "writer": 0, "publish": 0}),
                ),
            )
            self._conn.commit()
            rec = self.job(job_id)
            assert rec is not None
            self._write_result_json(rec)
            return rec

    # --- devices (USB ledger) -------------------------------------------------

    def upsert_device_seen(self, serial: str, model: str) -> None:
        now = utcnow_iso()
        with self._lock:
            self._conn.execute(
                "INSERT INTO devices (serial, model, adopted_at, last_seen_at, last_sync_at, last_error) "
                "VALUES (?, ?, NULL, ?, NULL, NULL) "
                "ON CONFLICT(serial) DO UPDATE SET model = CASE WHEN excluded.model != '' "
                "THEN excluded.model ELSE devices.model END, last_seen_at = excluded.last_seen_at",
                (serial, model, now),
            )
            self._conn.commit()

    def adopt_device(self, serial: str) -> None:
        now = utcnow_iso()
        with self._lock:
            self._conn.execute(
                "INSERT INTO devices (serial, model, adopted_at, last_seen_at, last_sync_at, last_error) "
                "VALUES (?, '', ?, NULL, NULL, NULL) "
                "ON CONFLICT(serial) DO UPDATE SET adopted_at = excluded.adopted_at",
                (serial, now),
            )
            self._conn.commit()

    def forget_device(self, serial: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE devices SET adopted_at = NULL, last_error = NULL WHERE serial = ?",
                (serial,),
            )
            self._conn.commit()

    def device_synced(self, serial: str, error: str | None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE devices SET last_sync_at = ?, last_error = ? WHERE serial = ?",
                (utcnow_iso(), error, serial),
            )
            self._conn.commit()

    def devices(self) -> list[DeviceInfo]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM devices ORDER BY adopted_at IS NULL, last_seen_at DESC"
            ).fetchall()
        return [
            DeviceInfo(
                serial=str(r["serial"]),
                model=str(r["model"] or ""),
                adopted=bool(r["adopted_at"]),
                adopted_at=str(r["adopted_at"]) if r["adopted_at"] else None,
                last_seen_at=str(r["last_seen_at"]) if r["last_seen_at"] else None,
                last_sync_at=str(r["last_sync_at"]) if r["last_sync_at"] else None,
                last_error=str(r["last_error"]) if r["last_error"] else None,
            )
            for r in rows
        ]

    def adopted_serials(self) -> set[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT serial FROM devices WHERE adopted_at IS NOT NULL"
            ).fetchall()
        return {str(r["serial"]) for r in rows}

    def mark_device_recording(
        self,
        serial: str,
        recording_id: str,
        *,
        device_status: str,
        title: str,
        created_at_ms: int,
    ) -> None:
        now = utcnow_iso()
        with self._lock:
            self._conn.execute(
                "INSERT INTO device_recordings (serial, recording_id, device_status, title, "
                "created_at_ms, first_seen_at, pulled_at, auto_job_id, changed_since_job, flag) "
                "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL) "
                "ON CONFLICT(serial, recording_id) DO UPDATE SET device_status = excluded.device_status, "
                "title = excluded.title, created_at_ms = excluded.created_at_ms",
                (serial, recording_id, device_status, title, created_at_ms, now),
            )
            self._conn.commit()

    def flag_device_recording(self, serial: str, recording_id: str, flag: str | None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE device_recordings SET flag = ? WHERE serial = ? AND recording_id = ?",
                (flag, serial, recording_id),
            )
            self._conn.commit()

    def device_recording_pulled(self, serial: str, recording_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE device_recordings SET pulled_at = ? WHERE serial = ? AND recording_id = ?",
                (utcnow_iso(), serial, recording_id),
            )
            self._conn.commit()

    def set_auto_job(self, serial: str, recording_id: str, job_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE device_recordings SET auto_job_id = ?, changed_since_job = 0 "
                "WHERE serial = ? AND recording_id = ?",
                (job_id, serial, recording_id),
            )
            self._conn.commit()

    def flag_changed_since_job(self, serial: str, recording_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE device_recordings SET changed_since_job = 1 WHERE serial = ? AND recording_id = ?",
                (serial, recording_id),
            )
            self._conn.commit()

    def device_file_state(self, serial: str, recording_id: str) -> dict[str, tuple[int, int]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT name, size, mtime FROM device_files WHERE serial = ? AND recording_id = ?",
                (serial, recording_id),
            ).fetchall()
        return {str(r["name"]): (int(r["size"]), int(r["mtime"])) for r in rows}

    def record_pulled_file(
        self,
        serial: str,
        recording_id: str,
        name: str,
        size: int,
        mtime: int,
        sha256: str,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO device_files (serial, recording_id, name, size, mtime, sha256, pulled_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(serial, recording_id, name) DO UPDATE SET size = excluded.size, "
                "mtime = excluded.mtime, sha256 = excluded.sha256, pulled_at = excluded.pulled_at",
                (serial, recording_id, name, size, mtime, sha256, utcnow_iso()),
            )
            self._conn.commit()

    def device_recordings(self, serial: str) -> list[DeviceRecording]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT r.*, "
                "(SELECT COUNT(*) FROM device_files f WHERE f.serial = r.serial AND f.recording_id = r.recording_id) AS file_count, "
                "(SELECT COALESCE(SUM(size), 0) FROM device_files f WHERE f.serial = r.serial AND f.recording_id = r.recording_id) AS bytes "
                "FROM device_recordings r WHERE r.serial = ? ORDER BY r.created_at_ms DESC",
                (serial,),
            ).fetchall()
            return [
                DeviceRecording(
                    serial=str(r["serial"]),
                    recording_id=str(r["recording_id"]),
                    device_status=str(r["device_status"] or ""),
                    title=str(r["title"] or ""),
                    created_at_ms=int(r["created_at_ms"] or 0),
                    first_seen_at=str(r["first_seen_at"]),
                    pulled_at=str(r["pulled_at"]) if r["pulled_at"] else None,
                    auto_job_id=str(r["auto_job_id"]) if r["auto_job_id"] else None,
                    changed_since_job=bool(int(r["changed_since_job"] or 0)),
                    flag=str(r["flag"]) if r["flag"] else None,
                    file_count=int(r["file_count"]),
                    bytes=int(r["bytes"]),
                    latest_job=self.latest_for(str(r["recording_id"])),
                )
                for r in rows
            ]

    # --- internals ---------------------------------------------------------

    def _begin_append(self, job_id: str, name: str, offset: int) -> tuple[Path | None, int, bool]:
        with self._lock:
            rec = self.job(job_id)
            if rec is None:
                raise UnknownJob(job_id)
            if rec.status != "uploading":
                raise JobNotUploading(job_id, rec.status)
            row = self._conn.execute(
                "SELECT size, sha256, received FROM job_files WHERE job_id = ? AND name = ?",
                (job_id, name),
            ).fetchone()
            if row is None:
                raise UnknownJob(f"{job_id}/{name}")
            current = self.file_received(job_id, name)
            if current is None:
                raise UnknownJob(f"{job_id}/{name}")
            if offset != current:
                raise OffsetMismatch(current)
            size = int(row["size"])
            if current == size:
                return None, size, True
            inbox = self.inbox_dir(rec.recording_id)
            return inbox / ".upload" / f"{name}.partial", size, False

    def _finish_append(self, job_id: str, name: str, received: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE job_files SET received = ? WHERE job_id = ? AND name = ?",
                (received, job_id, name),
            )
            self._conn.commit()

    def _files_for(self, job_id: str) -> list[FileSpec]:
        rows = self._conn.execute(
            "SELECT name, size, sha256 FROM job_files WHERE job_id = ? ORDER BY name",
            (job_id,),
        ).fetchall()
        return [
            FileSpec(name=str(r["name"]), size=int(r["size"]), sha256=str(r["sha256"]))
            for r in rows
        ]

    def _occupied_folders(self) -> list[tuple[str, str]]:
        rows = self._conn.execute(
            "SELECT publish_folder, recording_id FROM jobs WHERE publish_folder IS NOT NULL"
        ).fetchall()
        return [(str(r["publish_folder"]), str(r["recording_id"])) for r in rows]

    def _check_audio_mismatch(self, inbox: Path, job: JobRequest) -> None:
        incoming = {s.name: s for s in job.files if s.name in AUDIO_NAMES}
        for audio_name in AUDIO_NAMES:
            existing = inbox / audio_name
            if not existing.is_file():
                continue
            existing_hash = sha256_file(existing)
            spec = incoming.get(audio_name)
            if spec is None:
                # A different audio filename for the same recording still counts.
                other = next(iter(incoming.values()), None)
                if other is not None and other.sha256.lower() != existing_hash:
                    raise AudioMismatch(job.recording_id)
                continue
            if spec.sha256.lower() != existing_hash:
                raise AudioMismatch(job.recording_id)

    def _validate_request(self, job: JobRequest) -> None:
        title = job.title.strip()
        if not title or len(title) > 120:
            raise ValueError("title must be 1–120 characters")
        canonical_reviews(job.reviews)
        _check_recording_id(job.recording_id)
        if not job.files:
            raise ValueError("files manifest is empty")
        audio_count = 0
        seen: set[str] = set()
        for spec in job.files:
            if spec.name in seen:
                raise ValueError(f"duplicate file name: {spec.name}")
            seen.add(spec.name)
            if not FILE_NAME_RE.fullmatch(spec.name):
                raise ValueError(f"invalid file name: {spec.name}")
            if spec.name in AUDIO_NAMES:
                audio_count += 1
            elif not PHOTO_RE.fullmatch(spec.name):
                raise ValueError(f"file name not allowed: {spec.name}")
            if spec.size < 0:
                raise ValueError(f"invalid size for {spec.name}")
            if not SHA256_RE.fullmatch(spec.sha256):
                raise ValueError(f"invalid sha256 for {spec.name}")
        if audio_count != 1:
            raise ValueError("manifest must contain exactly one audio.m4a or audio.wav")

    def _predicted_url(self, folder: str | None, reviews: tuple[str, ...]) -> str | None:
        if not folder:
            return None
        page = "summary.html" if "summary" in reviews else "transcript.html"
        return naming.webdav_url(self.config, Path(folder), page)

    def _write_result_json(self, rec: JobRecord) -> None:
        data = self.result_json(rec.job_id)
        dest = self.outbox_dir(rec.recording_id) / "result.json"
        dest.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _job_from_row(self, row: sqlite3.Row) -> JobRecord:
        asr = json.loads(row["asr_json"]) if row["asr_json"] else None
        timings = json.loads(row["timings_json"]) if row["timings_json"] else {"asr": 0, "writer": 0, "publish": 0}
        created_at = str(row["created_at"])
        try:
            created_at_ms = _iso_to_ms(created_at)
        except ValueError:
            created_at_ms = 0
        files = self._files_for(str(row["job_id"]))
        reviews = _split_reviews(row["reviews"])
        folder = str(row["publish_folder"]) if row["publish_folder"] else None
        return JobRecord(
            job_id=str(row["job_id"]),
            recording_id=str(row["recording_id"]),
            status=str(row["status"]),
            error=str(row["error"]) if row["error"] else None,
            title=str(row["title"]),
            reviews=reviews,
            publish=bool(int(row["publish"])),
            writer=str(row["writer"]),
            webdav_url=self._predicted_url(folder, reviews),
            publish_folder=folder,
            skip_asr=bool(int(row["skip_asr"])),
            only_publish=bool(int(row["only_publish"])),
            created_at=created_at,
            updated_at=str(row["updated_at"]),
            finished_at=str(row["finished_at"]) if row["finished_at"] else None,
            asr=asr,
            timings={k: int(v) for k, v in timings.items()},
            created_at_ms=created_at_ms,
            files=files,
        )
