"""faster-whisper transcription. CUDA DLLs are wired onto PATH before import."""

from __future__ import annotations

import gc
import glob
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable


@dataclass
class AsrResult:
    model: str
    device: str
    language: str | None
    duration_ms: int


def _prepend_nvidia_bin_dirs() -> None:
    """ctranslate2 needs cuBLAS/cuDNN DLLs; add_dll_directory is not enough."""
    bindirs: list[str] = []
    for p in sys.path:
        bindirs += glob.glob(os.path.join(p, "nvidia", "*", "bin"))
    bindirs = [d for d in bindirs if os.path.isdir(d)]
    if bindirs:
        os.environ["PATH"] = os.pathsep.join(bindirs) + os.pathsep + os.environ.get("PATH", "")


def transcribe(
    audio_path: Path,
    out_dir: Path,
    *,
    model: str,
    device: str,
    language: str | None,
    log: Callable[[str], None],
) -> AsrResult:
    """Transcribe `audio_path` into `out_dir`/transcript.{txt,json}.

    `auto` tries cuda/float16 and falls back to cpu/int8 if CUDA fails at load
    *or* during decoding (the cuBLAS/cuDNN DLL errors surface on the first encode,
    not at construction). Explicit `cuda`/`cpu` never fall back.
    """
    _prepend_nvidia_bin_dirs()
    audio_path = Path(audio_path)
    out_dir = Path(out_dir)
    if not audio_path.is_file():
        raise FileNotFoundError(f"audio not found: {audio_path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    lang = language if language else None
    if not _model_cached(model):
        log(f"asr: model '{model}' is not cached yet; downloading from Hugging Face (first run, may take minutes)")

    if device == "auto":
        try:
            return _run(audio_path, out_dir, model, "cuda", "float16", lang, log)
        except Exception as exc:
            log(f"asr: cuda failed: {exc!r}")
            log("asr: falling back to cpu/int8")
            return _run(audio_path, out_dir, model, "cpu", "int8", lang, log)
    if device == "cuda":
        return _run(audio_path, out_dir, model, "cuda", "float16", lang, log)
    if device == "cpu":
        return _run(audio_path, out_dir, model, "cpu", "int8", lang, log)
    raise ValueError(f"unknown asr device: {device!r} (expected auto|cuda|cpu)")


def _model_cached(model: str) -> bool:
    """Best effort: is the faster-whisper model already in the Hugging Face cache? Unknown → True (no noise)."""
    if os.path.isdir(model):
        return True
    try:
        from faster_whisper.utils import _MODELS  # noqa: PLC0415
        from huggingface_hub import try_to_load_from_cache  # noqa: PLC0415
    except ImportError:
        return True
    repo = _MODELS.get(model, model)
    try:
        return isinstance(try_to_load_from_cache(repo, "model.bin"), str)
    except Exception:
        return True


def _run(
    audio_path: Path,
    out_dir: Path,
    model: str,
    device: str,
    compute_type: str,
    lang: str | None,
    log: Callable[[str], None],
) -> AsrResult:
    from faster_whisper import WhisperModel  # noqa: PLC0415 — import after PATH

    whisper_model = None
    try:
        log(f"asr: loading {device}/{compute_type}")
        whisper_model = WhisperModel(model, device=device, compute_type=compute_type)
        segments_iter, info = whisper_model.transcribe(
            str(audio_path),
            language=lang,
            word_timestamps=False,
            vad_filter=False,
        )
        segments: list[dict] = []
        paragraphs: list[str] = []
        for i, seg in enumerate(segments_iter):
            text = (seg.text or "").strip()
            seg_id = seg.id if getattr(seg, "id", None) is not None else i
            segments.append({"id": seg_id, "start": float(seg.start), "end": float(seg.end), "text": text})
            paragraphs.append(text)

        detected = getattr(info, "language", None) or lang
        duration_ms = int(round(float(getattr(info, "duration", 0.0) or 0.0) * 1000))

        (out_dir / "transcript.txt").write_text(
            "\n\n".join(paragraphs) + ("\n" if paragraphs else ""), encoding="utf-8"
        )
        payload = {
            "model": model,
            "device": device,
            "language": detected,
            "durationMs": duration_ms,
            "segments": segments,
        }
        (out_dir / "transcript.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        log(f"asr: wrote {len(segments)} segments on {device} language={detected!r} duration_ms={duration_ms}")
        return AsrResult(model=model, device=device, language=detected, duration_ms=duration_ms)
    finally:
        if whisper_model is not None:
            del whisper_model
            gc.collect()
