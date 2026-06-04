"""Regression test for the segmenter restart-storm (capture stability).

A dead camera's ffmpeg *spawns successfully* then exits in ~1-2 s. The
old watchdog reset the respawn backoff on every successful spawn, so the
exponential growth was undone every cycle → ffmpeg respawned every
~1-2 s forever (log flood + CPU churn). The fix only resets the backoff
after a *healthy run*; fast-fails keep it growing toward the cap.
"""

from __future__ import annotations

from maugood.capture.segmenter import (
    RESTART_BACKOFF_INITIAL_S,
    RESTART_BACKOFF_MAX_S,
    _HEALTHY_RUN_S,
    _next_backoff,
)


def test_fast_fails_grow_backoff_no_storm() -> None:
    # Simulate consecutive dead-camera fast-fails (ffmpeg exits ~1.5 s).
    backoff = RESTART_BACKOFF_INITIAL_S
    seq = []
    for _ in range(8):
        backoff = _next_backoff(ran_for=1.5, current_backoff=backoff)
        seq.append(backoff)
    # The storm bug would have kept this at INITIAL forever. Now it grows
    # exponentially and settles at the MAX cadence.
    assert seq[0] == 2.0
    assert seq[-1] == RESTART_BACKOFF_MAX_S
    assert all(b > RESTART_BACKOFF_INITIAL_S for b in seq)


def test_healthy_run_resets_backoff() -> None:
    # A process that streamed past the healthy threshold is a transient
    # blip → quick recovery (reset to INITIAL).
    assert _next_backoff(
        ran_for=_HEALTHY_RUN_S, current_backoff=16.0
    ) == RESTART_BACKOFF_INITIAL_S
    assert _next_backoff(
        ran_for=_HEALTHY_RUN_S + 10.0, current_backoff=RESTART_BACKOFF_MAX_S
    ) == RESTART_BACKOFF_INITIAL_S


def test_backoff_caps_at_max() -> None:
    assert _next_backoff(
        ran_for=0.5, current_backoff=RESTART_BACKOFF_MAX_S
    ) == RESTART_BACKOFF_MAX_S
