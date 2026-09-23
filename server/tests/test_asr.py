from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1cord_server.pipeline import asr as asr_mod
from r1cord_server.pipeline.asr import AsrResult, transcribe


def test_missing_audio_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="audio not found"):
        transcribe(
            tmp_path / "nope.m4a", tmp_path / "out",
            model="small", device="cpu", language=None, log=lambda _l: None,
        )


def test_unknown_device_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr_mod, "_model_cached", lambda model: True)
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"x")
    with pytest.raises(ValueError, match="unknown asr device"):
        transcribe(
            audio, tmp_path / "out",
            model="small", device="gpu", language=None, log=lambda _l: None,
        )


def test_auto_falls_back_to_cpu_int8_when_cuda_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr_mod, "_model_cached", lambda model: True)
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"x")
    runs: list[tuple[str, str]] = []

    def fake_run(audio_path, out_dir, model, device, compute_type, lang, log):
        runs.append((device, compute_type))
        if device == "cuda":
            raise RuntimeError("cuBLAS DLL not found")
        return AsrResult(model=model, device=device, language=lang, duration_ms=5)

    monkeypatch.setattr(asr_mod, "_run", fake_run)
    logs: list[str] = []
    result = transcribe(
        audio, tmp_path / "out", model="small", device="auto", language=None, log=logs.append,
    )

    assert runs == [("cuda", "float16"), ("cpu", "int8")]
    assert result.device == "cpu" and result.model == "small"
    assert any("falling back to cpu" in line for line in logs)


def test_explicit_cuda_never_falls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr_mod, "_model_cached", lambda model: True)
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"x")

    def failing_run(audio_path, out_dir, model, device, compute_type, lang, log):
        raise RuntimeError("cuBLAS DLL not found")

    monkeypatch.setattr(asr_mod, "_run", failing_run)
    with pytest.raises(RuntimeError, match="cuBLAS"):
        transcribe(
            audio, tmp_path / "out", model="small", device="cuda", language=None, log=lambda _l: None,
        )


def test_explicit_cpu_uses_int8_and_forwards_language(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(asr_mod, "_model_cached", lambda model: True)
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"x")
    seen: dict = {}

    def fake_run(audio_path, out_dir, model, device, compute_type, lang, log):
        seen.update(device=device, compute_type=compute_type, lang=lang)
        return AsrResult(model=model, device=device, language=lang, duration_ms=1)

    monkeypatch.setattr(asr_mod, "_run", fake_run)
    transcribe(
        audio, tmp_path / "out", model="small", device="cpu", language="fr", log=lambda _l: None,
    )
    assert seen == {"device": "cpu", "compute_type": "int8", "lang": "fr"}
