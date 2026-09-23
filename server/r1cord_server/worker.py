"""Serial job loop. Pipeline modules are imported lazily inside _run_job."""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from pathlib import Path

from .config import Config
from . import naming
from .store import JobRecord, JobStore

log = logging.getLogger("r1cord_server.worker")


class Worker:
    def __init__(self, store: JobStore, config: Config) -> None:
        self.store = store
        self.config = config
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

    def _run_job(self, job: JobRecord) -> None:
        fresh = self.store.job(job.job_id)
        if fresh is None:
            return
        job = fresh
        try:
            from .pipeline import asr, writers, publish, instructions
            from .mddocs import MdDocsBridge
        except ImportError as exc:
            self.store.set_status(job.job_id, "error", error=f"pipeline: {exc}")
            return

        def job_log(line: str) -> None:
            self.store.append_log(job.job_id, line)

        timings = dict(job.timings) if job.timings else {"asr": 0, "writer": 0, "publish": 0}

        if not job.only_publish:
            if not job.skip_asr:
                if not self._run_asr(job, asr, job_log, timings):
                    return
            else:
                job_log("asr: skipped")
                self.store.set_status(job.job_id, "transcribed", timings=timings)

            if (not job.summarize) or job.writer == "none":
                job_log("writer: skipped")
                self.store.set_status(job.job_id, "complete", timings=timings)
                return

            if not self._run_writer(job, writers, instructions, job_log, timings):
                return

            if not job.publish:
                job_log("publish: skipped")
                self.store.set_status(job.job_id, "complete", timings=timings)
                return

        if not self._run_publish(job, publish, MdDocsBridge, job_log, timings):
            return
        self.store.set_status(job.job_id, "complete", timings=timings)

    def _run_asr(self, job: JobRecord, asr: object, job_log: object, timings: dict[str, int]) -> bool:
        self.store.set_status(job.job_id, "transcribing", timings=timings)
        job_log("asr: start")
        inbox = self.store.inbox_dir(job.recording_id)
        audio = inbox / "audio.m4a"
        if not audio.is_file():
            audio = inbox / "audio.wav"
        if not audio.is_file():
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

    def _run_writer(
        self,
        job: JobRecord,
        writers: object,
        instructions: object,
        job_log: object,
        timings: dict[str, int],
    ) -> bool:
        self.store.set_status(job.job_id, "writing", timings=timings)
        job_log("writer: start")
        work = self.store.work_dir(job.job_id)
        outbox = self.store.outbox_dir(job.recording_id)
        inbox = self.store.inbox_dir(job.recording_id)
        try:
            for name in ("transcript.txt", "transcript.json"):
                src = outbox / name
                if not src.is_file():
                    raise FileNotFoundError(f"missing {name}")
                shutil.copy2(src, work / name)
            meta_src = inbox / "metadata.json"
            if meta_src.is_file():
                shutil.copy2(meta_src, work / "metadata.json")
                metadata = json.loads(meta_src.read_text(encoding="utf-8"))
            else:
                metadata = {}
            photos_dir = work / "photos"
            photos_dir.mkdir(exist_ok=True)
            photos: list[str] = []
            for src in sorted(inbox.glob("photo-*.jpg")):
                shutil.copy2(src, photos_dir / src.name)
                photos.append(src.name)
            text = instructions.build_instructions(  # type: ignore[attr-defined]
                job.title,
                job.summary_style,
                photos,
                metadata if isinstance(metadata, dict) else {},
            )
            (work / "INSTRUCTIONS.md").write_text(text, encoding="utf-8")
        except Exception as exc:
            self.store.set_status(job.job_id, "error", error=f"writer: {exc}", timings=timings)
            return False

        t0 = time.perf_counter()
        try:
            summary_path: Path = writers.summarize(  # type: ignore[attr-defined]
                work,
                writer=job.writer,
                timeout_s=self.config.writer_timeout_s,
                config=self.config,
                log=job_log,
            )
        except Exception as exc:
            timings["writer"] = int((time.perf_counter() - t0) * 1000)
            self.store.set_status(job.job_id, "error", error=f"writer: {exc}", timings=timings)
            return False
        timings["writer"] = int((time.perf_counter() - t0) * 1000)
        try:
            self._install_summary(job, Path(summary_path))
            out_photos = outbox / "photos"
            out_photos.mkdir(exist_ok=True)
            for src in (work / "photos").glob("*"):
                if src.is_file():
                    shutil.copy2(src, out_photos / src.name)
        except Exception as exc:
            self.store.set_status(job.job_id, "error", error=f"writer: {exc}", timings=timings)
            return False
        self.store.set_status(job.job_id, "written", timings=timings)
        job_log("writer: done")
        return True

    def _install_summary(self, job: JobRecord, summary_path: Path) -> None:
        outbox = self.store.outbox_dir(job.recording_id)
        dest = outbox / "summary.md"
        if dest.is_file():
            prev_id = job.job_id
            with_others = [
                h
                for h in self.store.result_json(job.job_id).get("history", [])
                if h.get("jobId") != job.job_id
                and h.get("status") in {"written", "published", "complete"}
            ]
            if with_others:
                prev_id = str(with_others[-1]["jobId"])
            archive = outbox / f"summary.{prev_id}.md"
            n = 2
            while archive.exists():
                archive = outbox / f"summary.{prev_id}-{n}.md"
                n += 1
            shutil.copy2(dest, archive)
        shutil.copy2(summary_path, dest)

    def _run_publish(
        self,
        job: JobRecord,
        publish: object,
        bridge_cls: type,
        job_log: object,
        timings: dict[str, int],
    ) -> bool:
        self.store.set_status(job.job_id, "publishing", timings=timings)
        job_log("publish: start")
        outbox = self.store.outbox_dir(job.recording_id)
        summary_md = outbox / "summary.md"
        if not summary_md.is_file():
            self.store.set_status(job.job_id, "error", error="publish: summary.md is missing", timings=timings)
            return False
        photos_dir = outbox / "photos"
        photos_dir.mkdir(exist_ok=True)
        if not job.publish_folder:
            self.store.set_status(job.job_id, "error", error="publish: publish folder is not set", timings=timings)
            return False
        folder = Path(job.publish_folder)
        t0 = time.perf_counter()
        try:
            bridge = bridge_cls()
            publish.publish(  # type: ignore[attr-defined]
                summary_md,
                photos_dir,
                folder,
                theme=self.config.theme,
                bridge=bridge,
                log=job_log,
            )
        except Exception as exc:
            timings["publish"] = int((time.perf_counter() - t0) * 1000)
            self.store.set_status(job.job_id, "error", error=f"publish: {exc}", timings=timings)
            return False
        timings["publish"] = int((time.perf_counter() - t0) * 1000)
        url = naming.webdav_url(self.config, folder)
        self.store.set_status(job.job_id, "published", webdav_url=url, timings=timings)
        job_log("publish: done")
        return True
