"""Serial job loop. Pipeline modules are imported lazily inside _run_job."""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from .config import Config
from .store import JobRecord, JobStore

log = logging.getLogger("r1cord_server.worker")


class Worker:
    def __init__(self, store: JobStore, config: Config, prompts_dir: Path | None = None) -> None:
        self.store = store
        self.config = config
        # Edited review prompts (`<kind>.md`) beside config.toml; None = the built-in defaults.
        self.prompts_dir = prompts_dir
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="r1cord-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            job = self.store.next_queued()
            if job is None:
                self._stop.wait(2)
                continue
            try:
                self._run_job(job)
            except Exception as exc:
                log.exception("worker crashed on job %s", job.job_id)
                try:
                    self.store.set_status(job.job_id, "error", error=f"worker: {exc}")
                except Exception:
                    log.exception("failed to record worker error for %s", job.job_id)
                continue
            self._email_if_complete(job.job_id)

    def _email_if_complete(self, job_id: str) -> None:
        """A failed email is logged to the job; it never changes the job's status."""
        if not self.config.email_enabled:
            return
        rec = self.store.job(job_id)
        if rec is None or rec.status != "complete":
            return
        from . import mailer

        try:
            mailer.email_job(self.store, self.config, job_id)
        except Exception as exc:
            log.warning("worker: job %s email failed: %s", job_id, exc)
            self.store.append_log(job_id, f"email: failed: {exc}")

    def _run_job(self, job: JobRecord) -> None:
        fresh = self.store.job(job.job_id)
        if fresh is None:
            return
        job = fresh
        try:
            from .pipeline import asr, writers, publish, instructions
        except ImportError as exc:
            log.warning("worker: job %s failed to import pipeline: %s", job.job_id, exc)
            self.store.set_status(job.job_id, "error", error=f"pipeline: {exc}")
            return

        def job_log(line: str) -> None:
            self.store.append_log(job.job_id, line)

        timings = dict(job.timings) if job.timings else {"asr": 0, "writer": 0, "publish": 0}

        writer_error = ""
        if job.only_publish:
            self._write_transcript_page(job, writers, job_log)
        else:
            if not job.skip_asr:
                if not self._run_asr(job, asr, job_log, timings):
                    return
            else:
                job_log("asr: skipped")
                self.store.set_status(job.job_id, "transcribed", timings=timings)
            self._write_transcript_page(job, writers, job_log)

            failures: dict[str, str] = {}
            if not job.reviews or job.writer == "none":
                job_log("writer: skipped")
            else:
                failures = self._run_reviews(job, writers, instructions, job_log, timings)
            writer_error = "\n".join(f"writer: {kind}: {reason}" for kind, reason in failures.items())

            if not job.publish:
                self._build_site(job, publish, job_log)
                job_log("publish: skipped")
                self._finish(job, writer_error, timings)
                return

        if not self._run_publish(job, publish, job_log, timings, writer_error):
            return
        self._finish(job, writer_error, timings)

    def _finish(self, job: JobRecord, writer_error: str, timings: dict[str, int]) -> None:
        """complete when every requested review was written, else error naming the failed ones."""
        if writer_error:
            self.store.set_status(job.job_id, "error", error=writer_error, timings=timings)
        else:
            self.store.set_status(job.job_id, "complete", timings=timings)

    def _run_asr(self, job: JobRecord, asr: object, job_log: object, timings: dict[str, int]) -> bool:
        self.store.set_status(job.job_id, "transcribing", timings=timings)
        job_log("asr: start")
        inbox = self.store.inbox_dir(job.recording_id)
        audio = inbox / "audio.m4a"
        if not audio.is_file():
            audio = inbox / "audio.wav"
        if not audio.is_file():
            log.warning("worker: job %s (%s) asr failed: no audio file in inbox", job.job_id, job.recording_id)
            self.store.set_status(job.job_id, "error", error="asr: no audio file in inbox")
            return False
        language = (self.config.asr_language or "").strip() or None
        t0 = time.perf_counter()
        try:
            result = asr.transcribe(  # type: ignore[attr-defined]
                audio,
                self.store.outbox_dir(job.recording_id),
                model=self.config.asr_model,
                device=self.config.asr_device,
                language=language,
                log=job_log,
            )
        except Exception as exc:
            log.warning("worker: job %s asr failed: %s", job.job_id, exc)
            timings["asr"] = int((time.perf_counter() - t0) * 1000)
            self.store.set_status(
                job.job_id,
                "error",
                error=f"asr: {exc}",
                timings=timings,
            )
            return False
        timings["asr"] = int((time.perf_counter() - t0) * 1000)
        asr_info = {
            "model": result.model,
            "device": result.device,
            "language": result.language,
            "durationMs": result.duration_ms,
        }
        self.store.set_status(job.job_id, "transcribed", asr=asr_info, timings=timings)
        job_log("asr: done")
        return True

    def _metadata(self, job: JobRecord) -> dict:
        path = self.store.inbox_dir(job.recording_id) / "metadata.json"
        if not path.is_file():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}

    def _write_transcript_page(self, job: JobRecord, writers: object, job_log: object) -> None:
        """outbox/transcript.md, the transcript page source. Rebuilt on every run; never fatal."""
        outbox = self.store.outbox_dir(job.recording_id)
        source = outbox / "transcript.txt"
        if not source.is_file():
            return
        try:
            text = writers.transcript_markdown(  # type: ignore[attr-defined]
                job.title,
                self._when(job),
                source.read_text(encoding="utf-8"),
            )
            (outbox / "transcript.md").write_text(text, encoding="utf-8")
        except Exception as exc:
            log.warning("worker: job %s transcript page failed: %s", job.job_id, exc)
            job_log(f"transcript page: failed: {exc}")

    def _when(self, job: JobRecord) -> str:
        """E.g. "2025-09-20 14:13 · 2:05", in this PC's local time, from metadata, else the job."""
        try:
            metadata = self._metadata(job)
        except (OSError, ValueError):
            metadata = {}
        try:
            created_ms = int(metadata.get("createdAt") or job.created_at_ms)
            duration_ms = int(metadata.get("durationMs") or (job.asr or {}).get("durationMs") or 0)
        except (TypeError, ValueError):
            created_ms, duration_ms = job.created_at_ms, 0
        parts = []
        if created_ms > 0:
            parts.append(datetime.fromtimestamp(created_ms / 1000).strftime("%Y-%m-%d %H:%M"))
        if duration_ms > 0:
            seconds = round(duration_ms / 1000)
            hours, rest = divmod(seconds, 3600)
            minutes, seconds = divmod(rest, 60)
            parts.append(f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}")
        return " · ".join(parts)

    def _run_reviews(
        self,
        job: JobRecord,
        writers: object,
        instructions: object,
        job_log: object,
        timings: dict[str, int],
    ) -> dict[str, str]:
        """Write each requested review in its own work folder; a failed one never stops the rest.

        Returns kind -> failure reason for the reviews that failed.
        """
        self.store.set_status(job.job_id, "writing", timings=timings)
        job_log(f"writer: start ({', '.join(job.reviews)})")
        work = self.store.work_dir(job.job_id)
        outbox = self.store.outbox_dir(job.recording_id)
        inbox = self.store.inbox_dir(job.recording_id)
        photos = [src.name for src in sorted(inbox.glob("photo-*.jpg"))]
        failures: dict[str, str] = {}
        total = 0
        for kind in job.reviews:
            t0 = time.perf_counter()
            try:
                kind_dir = self._prepare_review(job, kind, work / kind, photos, instructions)
                written: Path = writers.run_writer(  # type: ignore[attr-defined]
                    kind_dir,
                    kind=kind,
                    writer=job.writer,
                    timeout_s=self.config.writer_timeout_s,
                    config=self.config,
                    log=job_log,
                )
                self._install_review(job, kind, Path(written))
            except Exception as exc:
                elapsed = int((time.perf_counter() - t0) * 1000)
                total += elapsed
                log.warning("worker: job %s writer failed on %s: %s", job.job_id, kind, exc)
                job_log(f"writer: {kind}: failed after {elapsed} ms: {exc}")
                failures[kind] = str(exc)
                continue
            elapsed = int((time.perf_counter() - t0) * 1000)
            total += elapsed
            job_log(f"writer: {kind}: done in {elapsed} ms")
        timings["writer"] = total
        out_photos = outbox / "photos"
        out_photos.mkdir(exist_ok=True)
        for name in photos:
            shutil.copy2(inbox / name, out_photos / name)
        self.store.set_status(job.job_id, "written", timings=timings)
        job_log("writer: done" if not failures else f"writer: done, failed: {', '.join(failures)}")
        return failures

    def _prepare_review(
        self, job: JobRecord, kind: str, kind_dir: Path, photos: list[str], instructions: object
    ) -> Path:
        """work/<jobId>/<kind>/ with the transcript, metadata, photos and that review's INSTRUCTIONS.md."""
        outbox = self.store.outbox_dir(job.recording_id)
        inbox = self.store.inbox_dir(job.recording_id)
        kind_dir.mkdir(parents=True, exist_ok=True)
        stale = kind_dir / f"{kind}.md"
        if stale.is_file():
            stale.unlink()  # a retry must not validate the previous run's output
        for name in ("transcript.txt", "transcript.json"):
            src = outbox / name
            if not src.is_file():
                raise FileNotFoundError(f"missing {name}")
            shutil.copy2(src, kind_dir / name)
        meta_src = inbox / "metadata.json"
        if meta_src.is_file():
            shutil.copy2(meta_src, kind_dir / "metadata.json")
        photos_dir = kind_dir / "photos"
        photos_dir.mkdir(exist_ok=True)
        for name in photos:
            shutil.copy2(inbox / name, photos_dir / name)
        text = instructions.build_instructions(  # type: ignore[attr-defined]
            kind,
            job.title,
            instructions.load_prompt(self.prompts_dir, kind),  # type: ignore[attr-defined]
            photos,
            self._metadata(job),
        )
        (kind_dir / "INSTRUCTIONS.md").write_text(text, encoding="utf-8")
        return kind_dir

    def _install_review(self, job: JobRecord, kind: str, written: Path) -> None:
        """Copy `<kind>.md` into the outbox, archiving the previous version as `<kind>.<jobId>.md`."""
        outbox = self.store.outbox_dir(job.recording_id)
        dest = outbox / f"{kind}.md"
        if dest.is_file():
            prev_id = self.store.previous_review_job(job.recording_id, kind, job.job_id) or job.job_id
            archive = outbox / f"{kind}.{prev_id}.md"
            n = 2
            while archive.exists():
                archive = outbox / f"{kind}.{prev_id}-{n}.md"
                n += 1
            shutil.copy2(dest, archive)
        shutil.copy2(written, dest)

    def _build_site(self, job: JobRecord, publish: object, job_log: object) -> None:
        """outbox/<rid>/site in the configured theme, the local view, for a job that does not
        publish. A failure is logged, never fatal: the Markdown is the recording's real output."""
        outbox = self.store.outbox_dir(job.recording_id)
        try:
            with publish.SITE_LOCK:  # type: ignore[attr-defined]
                manifest = publish.build(  # type: ignore[attr-defined]
                    outbox, title=job.title or job.recording_id, theme=self.config.theme
                )
        except Exception as exc:
            log.warning("worker: job %s site build failed: %s", job.job_id, exc)
            job_log(f"site: failed: {exc}")
            return
        job_log(f"site: built {', '.join(manifest.pages)} ({manifest.theme})")

    def _run_publish(
        self,
        job: JobRecord,
        publish: object,
        job_log: object,
        timings: dict[str, int],
        writer_error: str,
    ) -> bool:
        """Build the site from every page whose Markdown exists, then deploy it to the publish
        folder. On failure the job ends in error, after any writer failures."""
        self.store.set_status(job.job_id, "publishing", timings=timings)
        job_log("publish: start")
        outbox = self.store.outbox_dir(job.recording_id)
        t0 = time.perf_counter()
        reason = ""
        try:
            with publish.SITE_LOCK:  # type: ignore[attr-defined]
                manifest = publish.build(  # type: ignore[attr-defined]
                    outbox, title=job.title or job.recording_id, theme=self.config.theme
                )
                job_log(f"site: built {', '.join(manifest.pages)} ({manifest.theme})")
                if job.publish_folder:
                    publish.deploy(outbox / publish.SITE_DIR, Path(job.publish_folder), job_log)  # type: ignore[attr-defined]
                else:
                    reason = "publish folder is not set"
        except Exception as exc:
            reason = str(exc)
        timings["publish"] = int((time.perf_counter() - t0) * 1000)
        if reason:
            log.warning("worker: job %s publish failed: %s", job.job_id, reason)
            error = f"publish: {reason}"
            self.store.set_status(
                job.job_id, "error", error=f"{writer_error}\n{error}" if writer_error else error, timings=timings
            )
            return False
        self.store.set_status(job.job_id, "published", timings=timings)
        job_log(f"publish: done ({', '.join(manifest.pages)})")
        return True
