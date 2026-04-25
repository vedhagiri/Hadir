"""Producer-side helpers — every call-site that fires a notification
goes through one of these.

The helpers respect the **in_app** preference at write time: if a
user has opted out of in-app for a category, no row is inserted at
all (so the bell badge stays clean). The **email** preference is
honoured by the delivery worker (``hadir.notifications.worker``) at
drain time; the row is created either way so we have an audit
trail of "this email *would have* fired except for the preference
flip".

That asymmetry mirrors common product expectations: silencing the
bell is "I don't want to see this", silencing email is "I don't
want this in my inbox" — the user reasonably expects either to be
honoured.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.engine import Connection

from hadir.db import roles, user_roles, users
from hadir.notifications.categories import Category
from hadir.notifications.repository import (
    insert_notification,
    resolve_preference,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def notify_user(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    category: Category,
    subject: str,
    body: str = "",
    link_url: Optional[str] = None,
    payload: Optional[dict] = None,
) -> Optional[int]:
    """Insert one notification for ``user_id`` if their in-app prefs
    allow it. Returns the new row id, or ``None`` when the
    preference suppresses the bell entry."""

    pref = resolve_preference(
        conn, scope, user_id=user_id, category=category
    )
    if not pref.in_app:
        return None
    return insert_notification(
        conn,
        scope,
        user_id=user_id,
        category=category,
        subject=subject,
        body=body,
        link_url=link_url,
        payload=payload or {},
    )


def _user_ids_with_role(
    conn: Connection, scope: TenantScope, *, role_code: str
) -> list[int]:
    rows = conn.execute(
        select(users.c.id)
        .select_from(
            users.join(
                user_roles,
                (user_roles.c.user_id == users.c.id)
                & (user_roles.c.tenant_id == users.c.tenant_id),
            ).join(
                roles,
                (roles.c.id == user_roles.c.role_id)
                & (roles.c.tenant_id == user_roles.c.tenant_id),
            )
        )
        .where(
            users.c.tenant_id == scope.tenant_id,
            users.c.is_active.is_(True),
            roles.c.code == role_code,
        )
        .distinct()
    ).all()
    return [int(r.id) for r in rows]


# ---------------------------------------------------------------------------
# Approval workflow producers
# ---------------------------------------------------------------------------


def notify_approval_assigned(
    conn: Connection,
    scope: TenantScope,
    *,
    request_id: int,
    request_type: str,
    submitter_name: str,
    target_user_ids: Iterable[int],
    stage: str,
) -> list[int]:
    """Manager (on submission) or HR (on manager-approve)."""

    subject = f"{stage} review: {request_type} request from {submitter_name}"
    body = (
        f"A {request_type} request has reached your queue. "
        f"Review and decide in the Approvals inbox."
    )
    link_url = f"/approvals?id={request_id}"
    written: list[int] = []
    for uid in target_user_ids:
        nid = notify_user(
            conn,
            scope,
            user_id=uid,
            category="approval_assigned",
            subject=subject,
            body=body,
            link_url=link_url,
            payload={"request_id": request_id, "stage": stage},
        )
        if nid is not None:
            written.append(nid)
    return written


def notify_approval_decided(
    conn: Connection,
    scope: TenantScope,
    *,
    request_id: int,
    employee_user_id: Optional[int],
    request_type: str,
    new_status: str,
    decider_label: str,
    comment: Optional[str],
) -> Optional[int]:
    """Employee on any terminal state."""

    if employee_user_id is None:
        return None
    pretty = new_status.replace("_", " ")
    subject = f"Your {request_type} request was {pretty}"
    body_lines = [f"{decider_label} marked your request as {pretty}."]
    if comment:
        body_lines.append("")
        body_lines.append(f"Comment: {comment}")
    return notify_user(
        conn,
        scope,
        user_id=employee_user_id,
        category="approval_decided",
        subject=subject,
        body="\n".join(body_lines),
        link_url=f"/my-requests?id={request_id}",
        payload={
            "request_id": request_id,
            "new_status": new_status,
            "decider": decider_label,
        },
    )


def notify_admin_override(
    conn: Connection,
    scope: TenantScope,
    *,
    request_id: int,
    request_type: str,
    actor_email: str,
    decision: str,
    comment: str,
    previous_stage: Optional[str],
    employee_user_id: Optional[int],
    manager_user_id: Optional[int],
    hr_user_id: Optional[int],
) -> list[int]:
    """One row per audience — Manager + HR (when present) + Employee."""

    pretty = decision.replace("_", " ")
    subject_template = f"Admin override · {request_type} request {pretty}"
    body = (
        f"An administrator overrode the {previous_stage or 'pending'} "
        f"decision on this request.\n\n"
        f"Comment: {comment}"
    )
    written: list[int] = []
    seen_user_ids: set[int] = set()

    def queue(uid: Optional[int]) -> None:
        if uid is None or uid in seen_user_ids:
            return
        seen_user_ids.add(uid)
        nid = notify_user(
            conn,
            scope,
            user_id=uid,
            category="admin_override",
            subject=subject_template,
            body=body,
            link_url=f"/approvals?id={request_id}",
            payload={
                "request_id": request_id,
                "decision": decision,
                "comment": comment,
                "previous_stage": previous_stage,
                "actor_email": actor_email,
            },
        )
        if nid is not None:
            written.append(nid)

    queue(manager_user_id)
    queue(hr_user_id)
    queue(employee_user_id)
    return written


# ---------------------------------------------------------------------------
# Operational producers
# ---------------------------------------------------------------------------


def notify_overtime_flagged(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    employee_code: str,
    employee_full_name: str,
    the_date,  # date
    overtime_minutes: int,
    manager_user_ids: Iterable[int],
) -> list[int]:
    """Manager (assigned to the employee) + every HR user receive a
    notification when ``overtime_minutes`` flips from 0 to > 0 for an
    employee on that date. The caller is responsible for the
    "first-time-that-day" gate (it has the cleanest view of the
    before-state).
    """

    hr_ids = _user_ids_with_role(conn, scope, role_code="HR")
    targets = list({*manager_user_ids, *hr_ids})
    subject = (
        f"Overtime flagged · {employee_full_name} ({employee_code}) "
        f"— {overtime_minutes} min on {the_date.isoformat()}"
    )
    body = (
        f"{employee_full_name} ({employee_code}) accumulated "
        f"{overtime_minutes} minutes of overtime on "
        f"{the_date.isoformat()}. Per BRD FR-ATT-005, review and "
        f"approve / reject via the Daily Attendance page."
    )
    link_url = f"/daily-attendance?date={the_date.isoformat()}"
    written: list[int] = []
    for uid in targets:
        nid = notify_user(
            conn,
            scope,
            user_id=uid,
            category="overtime_flagged",
            subject=subject,
            body=body,
            link_url=link_url,
            payload={
                "employee_id": employee_id,
                "date": the_date.isoformat(),
                "overtime_minutes": overtime_minutes,
            },
        )
        if nid is not None:
            written.append(nid)
    return written


def notify_camera_unreachable(
    conn: Connection,
    scope: TenantScope,
    *,
    camera_id: int,
    camera_name: str,
    minutes_unreachable: int,
) -> list[int]:
    admin_ids = _user_ids_with_role(conn, scope, role_code="Admin")
    subject = (
        f"Camera unreachable · {camera_name} for {minutes_unreachable} min"
    )
    body = (
        f"Camera {camera_name} (id={camera_id}) has been unreachable "
        f"for {minutes_unreachable} minutes. Per BRD NFR-AVL-003, "
        f"investigate via the Camera logs page."
    )
    link_url = "/camera-logs"
    written: list[int] = []
    for uid in admin_ids:
        nid = notify_user(
            conn,
            scope,
            user_id=uid,
            category="camera_unreachable",
            subject=subject,
            body=body,
            link_url=link_url,
            payload={
                "camera_id": camera_id,
                "minutes_unreachable": minutes_unreachable,
            },
        )
        if nid is not None:
            written.append(nid)
    return written


def notify_report_ready(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    fmt: str,
    range_label: str,
    download_link: Optional[str] = None,
) -> Optional[int]:
    return notify_user(
        conn,
        scope,
        user_id=user_id,
        category="report_ready",
        subject=f"Your {fmt.upper()} report is ready ({range_label})",
        body=(
            f"Your on-demand {fmt.upper()} attendance report for "
            f"{range_label} finished successfully. Open it from the "
            f"Reports page or the email we just sent."
        ),
        link_url=download_link or "/reports",
        payload={"format": fmt, "range_label": range_label},
    )
