"""Dev-only helpers used by the Playwright smoke test.

DO NOT mount these in production. ``hadir.main.create_app`` refuses to
attach this router unless ``HADIR_ENV == 'dev'`` — see also
``backend/CLAUDE.md`` "Dev-only test endpoints".
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import insert, select

from hadir.attendance.scheduler import recompute_today
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.cameras import rtsp as rtsp_io
from hadir.db import cameras, detection_events, employees, get_engine
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/_test", tags=["_test (dev only)"])

ADMIN = Depends(require_role("Admin"))


class SeedDetectionRequest(BaseModel):
    employee_code: str
    minutes_offset: int = -5  # default: a fresh event 5 minutes ago
    confidence: float = 0.93


class SeedDetectionResponse(BaseModel):
    detection_event_id: int
    employee_id: int
    captured_at: datetime
    used_camera_id: int


@router.post("/seed_detection", response_model=SeedDetectionResponse)
def seed_detection(
    payload: SeedDetectionRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> SeedDetectionResponse:
    """Insert one identified detection_events row for the named employee.

    Used by ``frontend/tests/pilot-smoke.spec.ts`` so the smoke test
    doesn't need a live camera or a real face. The bbox is a placeholder;
    the face_crop_path points at ``/dev/null`` (the smoke test doesn't
    request the crop).
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        emp_row = conn.execute(
            select(employees.c.id).where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.employee_code == payload.employee_code,
            )
        ).first()
        if emp_row is None:
            raise HTTPException(
                status_code=404,
                detail=f"unknown employee_code '{payload.employee_code}'",
            )
        # Reuse any existing camera or create a placeholder one. The
        # smoke test cleans up after itself; this row is harmless if
        # left in dev.
        cam_row = conn.execute(
            select(cameras.c.id)
            .where(cameras.c.tenant_id == scope.tenant_id)
            .order_by(cameras.c.id.asc())
            .limit(1)
        ).first()
        if cam_row is None:
            cam_id = conn.execute(
                insert(cameras)
                .values(
                    tenant_id=scope.tenant_id,
                    name="_test-cam",
                    location="seed_detection",
                    rtsp_url_encrypted=rtsp_io.encrypt_url(
                        "rtsp://127.0.0.1:1/_test"
                    ),
                    worker_enabled=False,
                    display_enabled=False,
                )
                .returning(cameras.c.id)
            ).scalar_one()
        else:
            cam_id = int(cam_row.id)

        captured_at = datetime.now(timezone.utc) + timedelta(
            minutes=payload.minutes_offset
        )

        new_id = conn.execute(
            insert(detection_events)
            .values(
                tenant_id=scope.tenant_id,
                camera_id=cam_id,
                captured_at=captured_at,
                bbox={"x": 0, "y": 0, "w": 50, "h": 50},
                face_crop_path="/dev/null",
                employee_id=int(emp_row.id),
                confidence=payload.confidence,
                track_id=f"_test-{int(captured_at.timestamp())}",
            )
            .returning(detection_events.c.id)
        ).scalar_one()

    logger.info(
        "_test/seed_detection inserted event id=%s employee=%s minutes_offset=%d",
        new_id,
        payload.employee_code,
        payload.minutes_offset,
    )
    return SeedDetectionResponse(
        detection_event_id=int(new_id),
        employee_id=int(emp_row.id),
        captured_at=captured_at,
        used_camera_id=cam_id,
    )


class RecomputeResponse(BaseModel):
    upserted: int


@router.post("/recompute_attendance", response_model=RecomputeResponse)
def recompute_attendance(user: Annotated[CurrentUser, ADMIN]) -> RecomputeResponse:
    """Run today's attendance recompute synchronously.

    Saves the smoke test from waiting up to 15 minutes for the
    background scheduler to fire.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    upserted = recompute_today(scope)
    return RecomputeResponse(upserted=upserted)


class TickMetricsResponse(BaseModel):
    ticks: int


@router.post("/tick_metrics", response_model=TickMetricsResponse)
def tick_metrics(user: Annotated[CurrentUser, ADMIN]) -> TickMetricsResponse:
    """P26 dev-only: bump every Hadir Prometheus counter once
    so the dashboard demo doesn't depend on a live RTSP camera.

    Mirrors what the real hot paths emit:
      * 24 capture frames (1 second of video at 4 fps × 6 sec)
      * 2 identified + 1 unidentified detection event
      * 7 attendance records computed
      * 2 sent / 1 failed email send (smtp provider)
      * No reachability change — that's set by the camera
        worker, not the test endpoint.
    """

    from hadir.metrics import (  # noqa: PLC0415
        observe_attendance_recomputed,
        observe_capture_frame,
        observe_detection_event,
        observe_email_send,
    )

    scope = TenantScope(tenant_id=user.tenant_id)
    ticks = 0
    for _ in range(24):
        observe_capture_frame(scope.tenant_id, 99001)
        ticks += 1
    observe_detection_event(scope.tenant_id, identified=True)
    observe_detection_event(scope.tenant_id, identified=True)
    observe_detection_event(scope.tenant_id, identified=False)
    ticks += 3
    observe_attendance_recomputed(scope.tenant_id, 7)
    ticks += 7
    observe_email_send(scope.tenant_id, provider="smtp", status="sent")
    observe_email_send(scope.tenant_id, provider="smtp", status="sent")
    observe_email_send(scope.tenant_id, provider="smtp", status="failed")
    ticks += 3
    logger.info("_test/tick_metrics ticked %s metric updates", ticks)
    return TickMetricsResponse(ticks=ticks)
