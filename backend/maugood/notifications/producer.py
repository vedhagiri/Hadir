"""Producer-side helpers — every call-site that fires a notification
goes through one of these.

The helpers respect the **in_app** preference at write time: if a
user has opted out of in-app for a category, no row is inserted at
all (so the bell badge stays clean). The **email** preference is
honoured by the delivery worker (``maugood.notifications.worker``) at
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

from maugood.db import roles, user_roles, users
from maugood.i18n import resolve_language, t
from maugood.notifications.categories import Category
from maugood.notifications.repository import (
    insert_notification,
    resolve_preference,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


def _user_preferred_language(
    conn: Connection, scope: TenantScope, *, user_id: int
) -> str:
    """Recipient's saved language. Defaults to the server default
    when the row has no explicit preference."""

    row = conn.execute(
        select(users.c.preferred_language).where(
            users.c.tenant_id == scope.tenant_id,
            users.c.id == user_id,
        )
    ).first()
    if row is None or row.preferred_language is None:
        return resolve_language()
    return resolve_language(user_preference=str(row.preferred_language))


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
    """Manager (on submission) or HR (on manager-approve).

    Each recipient sees the subject + body in their preferred
    language; English is the fallback when a key is missing.
    """

    link_url = f"/approvals?id={request_id}"
    written: list[int] = []
    for uid in target_user_ids:
        lang = _user_preferred_language(conn, scope, user_id=uid)
        stage_label = t(f"stages.{stage.lower()}", lang) if stage else stage
        subject = t(
            "notifications.approval_assigned.subject",
            lang,
            stage=stage_label,
            request_type=request_type,
            submitter_name=submitter_name,
        )
        body = t(
            "notifications.approval_assigned.body",
            lang,
            request_type=request_type,
        )
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
    lang = _user_preferred_language(
        conn, scope, user_id=employee_user_id
    )
    status_label = t(f"statuses.{new_status}", lang)
    subject = t(
        "notifications.approval_decided.subject",
        lang,
        request_type=request_type,
        status_label=status_label,
    )
    body_lines = [
        t(
            "notifications.approval_decided.body",
            lang,
            decider_label=decider_label,
            status_label=status_label,
        )
    ]
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

    written: list[int] = []
    seen_user_ids: set[int] = set()

    def queue(uid: Optional[int]) -> None:
        if uid is None or uid in seen_user_ids:
            return
        seen_user_ids.add(uid)
        lang = _user_preferred_language(conn, scope, user_id=uid)
        status_label = t(f"statuses.admin_{decision}d", lang) if False else t(
            f"statuses.{('admin_approved' if decision == 'approve' else 'admin_rejected')}",
            lang,
        )
        subject = t(
            "notifications.admin_override.subject",
            lang,
            request_type=request_type,
            status_label=status_label,
        )
        if previous_stage:
            stage_label = t(f"stages.{previous_stage.lower()}", lang)
            body = (
                t(
                    "notifications.admin_override.body",
                    lang,
                    previous_stage=stage_label,
                )
                + "\n\n"
                + f"Comment: {comment}"
            )
        else:
            body = (
                t("notifications.admin_override.body_no_prior", lang)
                + "\n\n"
                + f"Comment: {comment}"
            )
        nid = notify_user(
            conn,
            scope,
            user_id=uid,
            category="admin_override",
            subject=subject,
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
    link_url = f"/daily-attendance?date={the_date.isoformat()}"
    written: list[int] = []
    for uid in targets:
        lang = _user_preferred_language(conn, scope, user_id=uid)
        subject = t(
            "notifications.overtime_flagged.subject",
            lang,
            employee_full_name=employee_full_name,
            employee_code=employee_code,
            overtime_minutes=overtime_minutes,
            date=the_date.isoformat(),
        )
        body = t(
            "notifications.overtime_flagged.body",
            lang,
            employee_full_name=employee_full_name,
            employee_code=employee_code,
            overtime_minutes=overtime_minutes,
            date=the_date.isoformat(),
        )
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
    link_url = "/camera-logs"
    written: list[int] = []
    for uid in admin_ids:
        lang = _user_preferred_language(conn, scope, user_id=uid)
        subject = t(
            "notifications.camera_unreachable.subject",
            lang,
            camera_name=camera_name,
            minutes_unreachable=minutes_unreachable,
        )
        body = t(
            "notifications.camera_unreachable.body",
            lang,
            camera_name=camera_name,
            camera_id=camera_id,
            minutes_unreachable=minutes_unreachable,
        )
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
    lang = _user_preferred_language(conn, scope, user_id=user_id)
    fmt_upper = fmt.upper()
    subject = t(
        "notifications.report_ready.subject",
        lang,
        format_upper=fmt_upper,
        range_label=range_label,
    )
    body = t(
        "notifications.report_ready.body",
        lang,
        format_upper=fmt_upper,
        range_label=range_label,
    )
    return notify_user(
        conn,
        scope,
        user_id=user_id,
        category="report_ready",
        subject=subject,
        body=body,
        link_url=download_link or "/reports",
        payload={"format": fmt, "range_label": range_label},
    )
