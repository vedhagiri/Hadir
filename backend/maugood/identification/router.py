"""FastAPI router for ``/api/identification/*`` — Admin only."""

from __future__ import annotations

import logging
from datetime import date as date_type, datetime, time as time_type, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_role
from maugood.db import detection_events, get_engine
from maugood.identification import enrollment
from maugood.identification.embeddings import decrypt_embedding
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/identification", tags=["identification"])

ADMIN = Depends(require_role("Admin"))


class ReembedResult(BaseModel):
    enrolled: int
    skipped: int
    errors: int


@router.post("/reembed", response_model=ReembedResult)
def reembed_endpoint(user: Annotated[CurrentUser, ADMIN]) -> ReembedResult:
    """Clear every enrolled embedding and recompute them from the stored photos.

    Use after a model upgrade or when tuning the recogniser. Synchronous
    in the pilot — on large tenants this can take a few minutes. v1.0
    moves this onto a background job with progress reporting.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    result = enrollment.reembed_all(get_engine(), scope)

    engine = get_engine()
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="identification.reembedded",
            entity_type="tenant",
            after={
                "enrolled": result.enrolled,
                "skipped": result.skipped,
                "errors": result.errors,
            },
        )
    logger.info(
        "identification reembed done: enrolled=%d skipped=%d errors=%d",
        result.enrolled,
        result.skipped,
        result.errors,
    )
    return ReembedResult(
        enrolled=result.enrolled, skipped=result.skipped, errors=result.errors
    )


# ---------------------------------------------------------------------------
# Rematch — replays past detection_events through the (now updated)
# matcher cache so newly-uploaded reference photos retroactively assign
# employee_id on the events. Designed to be re-runnable any number of
# times for the same date — each run reads the current cache state and
# only writes to rows whose match decision actually changed.
# ---------------------------------------------------------------------------


class RematchRequest(BaseModel):
    # Date range is inclusive on both ends. Single-day caller sets
    # from_date == to_date.
    from_date: date_type = Field(..., alias="from")
    to_date: date_type = Field(..., alias="to")
    # When true (default) only detection_events with employee_id IS NULL
    # AND former_match_employee_id IS NULL are scanned. When false,
    # already-identified rows are also re-evaluated — useful when the
    # operator wants to flip an old wrong-match because they swapped
    # the reference photo, or after lowering the match threshold.
    only_unidentified: bool = True
    # When true (default) we run attendance recompute for every
    # (employee_id, local_date) pair whose match decision changed.
    recompute_attendance: bool = True

    model_config = {"populate_by_name": True}


class RematchResult(BaseModel):
    events_scanned: int
    matches_added: int  # NULL → identified
    matches_changed: int  # identified → different employee
    attendance_recomputed: int  # number of (employee_id, date) pairs


@router.post("/rematch", response_model=RematchResult)
def rematch_endpoint(
    payload: RematchRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> RematchResult:
    """Replay past detection_events through the current matcher cache.

    Idempotent — every run reads the cache as it stands right now and
    rewrites only the rows whose match decision actually changes. The
    operator can re-run the same date repeatedly: upload a reference
    photo, run rematch, see how many events became identified, upload
    a sharper photo, run again, and so on.

    Range bounds are interpreted as the tenant's local-day boundaries
    expanded into UTC, so a Muscat operator picking 2026-04-29 hits
    every event captured between 2026-04-28 20:00 UTC and 2026-04-29
    19:59:59 UTC.
    """

    if payload.from_date > payload.to_date:
        raise HTTPException(
            status_code=400, detail="'from' must be on or before 'to'"
        )

    scope = TenantScope(tenant_id=user.tenant_id)

    # Resolve UTC bounds from the tenant's local timezone — matches
    # how the Reports / Calendar pages translate a picked local day
    # into a captured_at window. We need the tenant tz before the
    # "future" check too; a Muscat operator on 2026-05-02 would be
    # rejected if we compared against UTC today (still 2026-05-01).
    from maugood.attendance.repository import (  # noqa: PLC0415
        load_tenant_settings,
        local_tz_for,
    )

    engine = get_engine()
    with engine.begin() as conn:
        settings_snap = load_tenant_settings(conn, scope)
    tenant_tz = local_tz_for(settings_snap)

    today_local = datetime.now(timezone.utc).astimezone(tenant_tz).date()
    if payload.to_date > today_local:
        raise HTTPException(
            status_code=400, detail="'to' cannot be in the future"
        )

    start_local = datetime.combine(
        payload.from_date, time_type(0, 0, 0)
    ).replace(tzinfo=tenant_tz)
    end_local = datetime.combine(
        payload.to_date, time_type(23, 59, 59, 999_000)
    ).replace(tzinfo=tenant_tz)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)

    # Pull the candidate rows. We restrict to rows that have an
    # embedding to replay through; without one there's nothing to
    # match against.
    base_filter = [
        detection_events.c.tenant_id == scope.tenant_id,
        detection_events.c.captured_at >= start_utc,
        detection_events.c.captured_at <= end_utc,
        detection_events.c.embedding.is_not(None),
    ]
    if payload.only_unidentified:
        base_filter.extend(
            [
                detection_events.c.employee_id.is_(None),
                detection_events.c.former_match_employee_id.is_(None),
            ]
        )

    with engine.begin() as conn:
        rows = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.captured_at,
                detection_events.c.employee_id,
                detection_events.c.former_match_employee_id,
                detection_events.c.former_employee_match,
                detection_events.c.confidence,
                detection_events.c.embedding,
            ).where(and_(*base_filter))
        ).all()

    events_scanned = len(rows)
    matches_added = 0
    matches_changed = 0
    # Keys are (employee_id, local_date_iso). Used to drive a single
    # recompute_for() per pair at the end.
    affected_pairs: set[tuple[int, date_type]] = set()

    with engine.begin() as conn:
        for row in rows:
            try:
                vec = decrypt_embedding(bytes(row.embedding))
            except RuntimeError as exc:
                logger.debug(
                    "rematch: skipping event %s — decrypt failed (%s)",
                    row.id,
                    exc,
                )
                continue

            match = matcher_cache.match(scope, vec)

            new_employee_id: Optional[int] = None
            new_former_id: Optional[int] = None
            new_former_flag = False
            new_confidence: Optional[float] = None

            if match is not None:
                new_confidence = match.score
                if match.classification == "active":
                    new_employee_id = match.employee_id
                elif match.classification == "inactive":
                    new_former_id = match.employee_id
                    new_former_flag = True
                # ``future`` falls through — neither column is set.

            cur_employee_id = (
                int(row.employee_id) if row.employee_id is not None else None
            )
            cur_former_id = (
                int(row.former_match_employee_id)
                if row.former_match_employee_id is not None
                else None
            )

            # Skip writes when nothing changed — keeps re-runs cheap
            # and the audit trail clean.
            unchanged = (
                cur_employee_id == new_employee_id
                and cur_former_id == new_former_id
                and bool(row.former_employee_match) == new_former_flag
            )
            if unchanged:
                continue

            conn.execute(
                update(detection_events)
                .where(
                    detection_events.c.id == row.id,
                    detection_events.c.tenant_id == scope.tenant_id,
                )
                .values(
                    employee_id=new_employee_id,
                    former_match_employee_id=new_former_id,
                    former_employee_match=new_former_flag,
                    confidence=new_confidence,
                )
            )

            # Bookkeeping for the summary + attendance recompute.
            if cur_employee_id is None and new_employee_id is not None:
                matches_added += 1
            elif (
                cur_employee_id is not None
                and new_employee_id is not None
                and cur_employee_id != new_employee_id
            ):
                matches_changed += 1

            local_date = (
                row.captured_at.astimezone(tenant_tz).date()
            )
            # Recompute should cover both the employee that just got
            # the row and the employee that lost it (if any).
            for eid in (cur_employee_id, new_employee_id):
                if eid is not None:
                    affected_pairs.add((eid, local_date))

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="identification.rematched",
            entity_type="tenant",
            after={
                "from": payload.from_date.isoformat(),
                "to": payload.to_date.isoformat(),
                "only_unidentified": payload.only_unidentified,
                "recompute_attendance": payload.recompute_attendance,
                "events_scanned": events_scanned,
                "matches_added": matches_added,
                "matches_changed": matches_changed,
            },
        )

    attendance_recomputed = 0
    if payload.recompute_attendance and affected_pairs:
        from maugood.attendance import scheduler as att_scheduler  # noqa: PLC0415

        for emp_id, the_date in sorted(affected_pairs):
            try:
                if att_scheduler.recompute_for(
                    scope, employee_id=emp_id, the_date=the_date
                ):
                    attendance_recomputed += 1
            except Exception:  # pragma: no cover — bound by the loop
                logger.warning(
                    "rematch: recompute_for failed for emp=%s date=%s",
                    emp_id,
                    the_date,
                    exc_info=True,
                )

    logger.info(
        "identification rematch done: from=%s to=%s scanned=%d added=%d changed=%d attendance=%d only_unidentified=%s",
        payload.from_date,
        payload.to_date,
        events_scanned,
        matches_added,
        matches_changed,
        attendance_recomputed,
        payload.only_unidentified,
    )
    return RematchResult(
        events_scanned=events_scanned,
        matches_added=matches_added,
        matches_changed=matches_changed,
        attendance_recomputed=attendance_recomputed,
    )
