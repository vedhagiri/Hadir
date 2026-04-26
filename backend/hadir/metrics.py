"""Prometheus metrics (v1.0 P26).

Single source of truth for every metric Hadir emits. Importers
mutate the module-level objects below; the FastAPI app exposes
them at ``/metrics`` (internal-only — nginx in
``ops/nginx/hadir.conf.template`` does NOT proxy this path).

**PDPL red line**: every label here is opaque (numeric IDs,
provider names, status values). No employee names, no email
addresses, no faces, no tenant slugs that map to a real-world
brand. ``camera`` is the camera id (an integer); ``tenant`` is
the tenant id (an integer). If a future phase needs per-employee
metrics, attach the ``employee_id`` (still numeric) — never the
name.

The instrumentator's HTTP histograms cover request duration and
status code distribution out of the box; we bind it in
``main.create_app`` and let it auto-discover the router prefixes.
"""

from __future__ import annotations

import logging
from typing import Any

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    REGISTRY,
)

logger = logging.getLogger(__name__)


# --- the seven custom metrics from the prompt -----------------------

# 1. Capture frames per tenant + camera.
hadir_capture_frames_total = Counter(
    "hadir_capture_frames_total",
    "Frames pulled from RTSP cameras and offered to the analyzer.",
    ["tenant", "camera"],
)

# 2. Detection events (faces detected) — labelled by whether the
#    matcher pinned an employee_id ("identified=true") or not.
hadir_detection_events_total = Counter(
    "hadir_detection_events_total",
    "Per-track detection events written to the database.",
    ["tenant", "identified"],
)

# 3. Camera reachability — 1 when the latest health snapshot is
#    reachable=true, 0 otherwise. The capture worker updates this
#    on every per-minute health flush.
hadir_camera_reachable = Gauge(
    "hadir_camera_reachable",
    "Latest reachable status of an enabled camera (1=reachable, 0=down).",
    ["tenant", "camera"],
)

# 4. Attendance records computed per tenant.
hadir_attendance_records_computed_total = Counter(
    "hadir_attendance_records_computed_total",
    "Attendance rows upserted by the recompute scheduler.",
    ["tenant"],
)

# 5. Scheduler job failure counter — labelled by job name.
hadir_scheduler_jobs_failed_total = Counter(
    "hadir_scheduler_jobs_failed_total",
    "Background-scheduler job runs that raised before completion.",
    ["tenant", "job"],
)

# 6. Email delivery — labelled by provider + outcome status.
hadir_email_send_total = Counter(
    "hadir_email_send_total",
    "Emails the worker tried to send, broken down by provider + status.",
    ["tenant", "provider", "status"],
)

# 7. Active sessions per tenant. Refreshed by the metrics
#    background tick — see ``hadir.metrics.refresher``.
hadir_active_sessions = Gauge(
    "hadir_active_sessions",
    "Non-expired user_sessions rows per tenant.",
    ["tenant"],
)


# --- helpers ---------------------------------------------------------

# All custom metrics for tests + diagnostics.
ALL_METRICS = (
    hadir_capture_frames_total,
    hadir_detection_events_total,
    hadir_camera_reachable,
    hadir_attendance_records_computed_total,
    hadir_scheduler_jobs_failed_total,
    hadir_email_send_total,
    hadir_active_sessions,
)


def reset_for_tests(registry: CollectorRegistry | None = None) -> None:
    """Reset every custom metric. Used by tests that assert on
    deltas — without this they leak counts across cases."""

    for metric in ALL_METRICS:
        try:
            metric.clear()  # type: ignore[attr-defined]
        except AttributeError:
            pass


def _safe_label(value: Any) -> str:
    """Coerce label values to short strings.

    Defensive — a label that ends up ``None`` would silently
    bucket as the literal string "None", which messes up
    aggregation. We coerce to ``""`` so the bucket is at least
    obvious.
    """

    if value is None:
        return ""
    s = str(value)
    # Cap label length so a stray UUID doesn't blow up cardinality.
    return s[:128]


def observe_capture_frame(tenant_id: int | None, camera_id: int | None) -> None:
    hadir_capture_frames_total.labels(
        tenant=_safe_label(tenant_id), camera=_safe_label(camera_id)
    ).inc()


def observe_detection_event(
    tenant_id: int | None, *, identified: bool
) -> None:
    hadir_detection_events_total.labels(
        tenant=_safe_label(tenant_id),
        identified="true" if identified else "false",
    ).inc()


def set_camera_reachable(
    tenant_id: int | None, camera_id: int | None, *, reachable: bool
) -> None:
    hadir_camera_reachable.labels(
        tenant=_safe_label(tenant_id), camera=_safe_label(camera_id)
    ).set(1.0 if reachable else 0.0)


def observe_attendance_recomputed(tenant_id: int | None, count: int) -> None:
    if count <= 0:
        return
    hadir_attendance_records_computed_total.labels(
        tenant=_safe_label(tenant_id)
    ).inc(count)


def observe_scheduler_failure(
    tenant_id: int | None, *, job: str
) -> None:
    hadir_scheduler_jobs_failed_total.labels(
        tenant=_safe_label(tenant_id), job=_safe_label(job)
    ).inc()


def observe_email_send(
    tenant_id: int | None, *, provider: str, status: str
) -> None:
    """``status`` is one of ``sent``/``failed``/``skipped_pref``/
    ``skipped_no_email``. ``provider`` is the SenderConfig's
    ``provider`` field — ``smtp``, ``microsoft_graph``, or
    ``recorder`` (dev/test mode)."""

    hadir_email_send_total.labels(
        tenant=_safe_label(tenant_id),
        provider=_safe_label(provider),
        status=_safe_label(status),
    ).inc()


def set_active_sessions(tenant_id: int | None, count: int) -> None:
    hadir_active_sessions.labels(tenant=_safe_label(tenant_id)).set(
        float(count)
    )


# --- APScheduler instrumentation -------------------------------------

# Listener attached by each scheduler's start() — wraps job
# error events and bumps the failure counter.
def install_scheduler_failure_listener(
    scheduler: Any, *, job_name: str, tenant_id: int | None = None
) -> None:
    """Register an APScheduler listener so a raised job
    increments ``hadir_scheduler_jobs_failed_total``.

    Imported lazily by each scheduler's ``start()`` to avoid an
    APScheduler import in tests that neutralise the schedulers.
    """

    try:
        from apscheduler.events import EVENT_JOB_ERROR  # noqa: PLC0415
    except ImportError:
        logger.debug("apscheduler not available; skipping listener install")
        return

    def _on_error(event: Any) -> None:
        observe_scheduler_failure(tenant_id, job=job_name)
        logger.warning(
            "scheduler job failed: name=%s tenant=%s exc=%s",
            job_name,
            tenant_id,
            getattr(event, "exception", None),
        )

    scheduler.add_listener(_on_error, EVENT_JOB_ERROR)


__all__ = [
    "hadir_capture_frames_total",
    "hadir_detection_events_total",
    "hadir_camera_reachable",
    "hadir_attendance_records_computed_total",
    "hadir_scheduler_jobs_failed_total",
    "hadir_email_send_total",
    "hadir_active_sessions",
    "ALL_METRICS",
    "reset_for_tests",
    "observe_capture_frame",
    "observe_detection_event",
    "set_camera_reachable",
    "observe_attendance_recomputed",
    "observe_scheduler_failure",
    "observe_email_send",
    "set_active_sessions",
    "install_scheduler_failure_listener",
]
