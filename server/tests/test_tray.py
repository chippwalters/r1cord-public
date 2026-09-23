from __future__ import annotations

from types import SimpleNamespace

from r1cord_server.tray import NOTIFY_MESSAGE_MAX, TOOLTIP_MAX, device_line, finished_since, tooltip, work_line


def _job(
    job_id: str, status: str, *, title: str = "Site visit", reviews: tuple[str, ...] = ("summary",), error: str | None = None
):
    return SimpleNamespace(job_id=job_id, recording_id=f"rec-{job_id}", status=status, title=title, reviews=reviews, error=error)


def test_device_line_prefers_an_adopted_device_and_respects_usb_off() -> None:
    assert device_line([], usb_enabled=False) == "USB mode off"
    assert device_line([("S1", "Rabbit_R1", True)], usb_enabled=False) == "USB mode off"
    assert device_line([], usb_enabled=True) == "No device connected"
    assert device_line([("PHONE", "Pixel", False)], usb_enabled=True) == "Device connected, not adopted"
    assert device_line([("PHONE", "Pixel", False), ("S1", "Rabbit_R1", True)], usb_enabled=True) == "Rabbit R1 connected"


def test_work_line_names_the_running_job_and_counts_the_queue() -> None:
    assert work_line([_job("a", "complete")]) == "Idle"
    assert work_line([_job("a", "queued"), _job("b", "queued")]) == "2 queued"
    assert work_line([_job("a", "queued"), _job("b", "transcribing", title="Kickoff")]) == "Transcribing: Kickoff (+1 queued)"


def test_tooltip_fits_the_windows_limit() -> None:
    assert tooltip("No device connected", "Idle") == "R1CORD Server · No device connected · Idle"
    long = tooltip("No device connected", "Writing: " + "x" * 300)
    assert len(long) == TOOLTIP_MAX and long.endswith("…")


def test_finished_since_announces_only_transitions_into_a_final_state() -> None:
    seen: dict[str, str] = {}
    # First poll: old jobs are already final; nothing just finished.
    assert finished_since(seen, [_job("old", "complete"), _job("new", "writing")]) == []
    assert finished_since(seen, [_job("old", "complete"), _job("new", "writing")]) == []
    assert finished_since(seen, [_job("old", "complete"), _job("new", "complete")]) == [("Summary ready", "Site visit")]
    # Transcribe-only job, several reviews, then a failure.
    assert finished_since(seen, [_job("t", "queued", reviews=())]) == []
    assert finished_since(seen, [_job("t", "complete", reviews=())]) == [("Transcript ready", "Site visit")]
    assert finished_since(seen, [_job("o", "writing", reviews=("organized",))]) == []
    assert finished_since(seen, [_job("o", "complete", reviews=("organized",))]) == [("Cleaned up & organized ready", "Site visit")]
    assert finished_since(seen, [_job("m", "writing", reviews=("summary", "outline"))]) == []
    assert finished_since(seen, [_job("m", "complete", reviews=("summary", "outline"))]) == [("AI reviews ready", "Site visit")]
    assert finished_since(seen, [_job("e", "writing")]) == []
    assert finished_since(seen, [_job("e", "error", error="writer: timeout")]) == [("Job failed", "Site visit: writer: timeout")]


def test_device_line_counts_extra_adopted_devices_and_falls_back_to_the_serial() -> None:
    assert device_line([("S1", "Rabbit_R1", True), ("S2", "Pixel_9", True)], usb_enabled=True) == "Rabbit R1 connected (+1)"
    assert device_line([("S3", "", True)], usb_enabled=True) == "S3 connected"


def test_work_line_names_the_recording_when_the_running_job_has_no_title() -> None:
    assert work_line([_job("b", "writing", title=None)]) == "Writing: rec-b"


def test_finished_since_error_without_detail_points_at_the_log() -> None:
    seen = {"e": "writing"}
    assert finished_since(seen, [_job("e", "error", error=None)]) == [("Job failed", "Site visit: see the job log")]


def test_failure_notifications_fit_the_windows_balloon_limit() -> None:
    # Real writer failures carry the whole argv and CLI output (464 characters crashed the tray).
    error = "writer claude_code exited 1\nargv: [" + "x" * 400 + "]\nFailed to authenticate: OAuth session expired"
    seen = {"e": "writing"}
    [(title, message)] = finished_since(seen, [_job("e", "error", error=error, title="T" * 300)])
    assert title == "Job failed"
    assert len(message) <= NOTIFY_MESSAGE_MAX and message.endswith("…")
    seen = {"e": "writing"}
    [(_, short)] = finished_since(seen, [_job("e", "error", error=error)])
    assert short == "Site visit: writer claude_code exited 1"  # first line only
