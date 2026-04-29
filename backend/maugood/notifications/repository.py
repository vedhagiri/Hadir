"""DB layer for notifications + preferences.

The preference resolver is **default-true** for both channels — a
missing row means "deliver in-app and email". Operators flip rows
to opt out. The delivery worker re-resolves on every drain so a
preference change takes effect within one tick.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, insert, select, update
from sqlalchemy.engine import Connection

from maugood.db import notification_preferences, notifications
from maugood.notifications.categories import ALL_CATEGORIES, Category
from maugood.tenants.scope import TenantScope


@dataclass(frozen=True, slots=True)
class NotificationRow:
    id: int
    tenant_id: int
    user_id: int
    category: str
    subject: str
    body: str
    link_url: Optional[str]
    payload: dict
    read_at: Optional[datetime]
    email_sent_at: Optional[datetime]
    email_attempts: int
    email_failed_at: Optional[datetime]
    email_error: Optional[str]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class PreferenceRow:
    user_id: int
    tenant_id: int
    category: str
    in_app: bool
    email: bool


def _row_to_notification(row) -> NotificationRow:  # type: ignore[no-untyped-def]
    return NotificationRow(
        id=int(row.id),
        tenant_id=int(row.tenant_id),
        user_id=int(row.user_id),
        category=str(row.category),
        subject=str(row.subject),
        body=str(row.body or ""),
        link_url=row.link_url,
        payload=dict(row.payload or {}),
        read_at=row.read_at,
        email_sent_at=row.email_sent_at,
        email_attempts=int(row.email_attempts),
        email_failed_at=row.email_failed_at,
        email_error=row.email_error,
        created_at=row.created_at,
    )


_NOTIFICATION_COLS = (
    notifications.c.id,
    notifications.c.tenant_id,
    notifications.c.user_id,
    notifications.c.category,
    notifications.c.subject,
    notifications.c.body,
    notifications.c.link_url,
    notifications.c.payload,
    notifications.c.read_at,
    notifications.c.email_sent_at,
    notifications.c.email_attempts,
    notifications.c.email_failed_at,
    notifications.c.email_error,
    notifications.c.created_at,
)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_for_user(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    limit: int = 50,
) -> list[NotificationRow]:
    rows = conn.execute(
        select(*_NOTIFICATION_COLS)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.user_id == user_id,
        )
        .order_by(notifications.c.id.desc())
        .limit(limit)
    ).all()
    return [_row_to_notification(r) for r in rows]


def unread_count_for_user(
    conn: Connection, scope: TenantScope, *, user_id: int
) -> int:
    from sqlalchemy import func as sa_func  # noqa: PLC0415

    return int(
        conn.execute(
            select(sa_func.count()).where(
                notifications.c.tenant_id == scope.tenant_id,
                notifications.c.user_id == user_id,
                notifications.c.read_at.is_(None),
            )
        ).scalar_one()
    )


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def insert_notification(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    category: Category,
    subject: str,
    body: str,
    link_url: Optional[str],
    payload: Optional[dict] = None,
) -> int:
    return int(
        conn.execute(
            insert(notifications)
            .values(
                tenant_id=scope.tenant_id,
                user_id=user_id,
                category=category,
                subject=subject,
                body=body,
                link_url=link_url,
                payload=payload or {},
            )
            .returning(notifications.c.id)
        ).scalar_one()
    )


def mark_read(
    conn: Connection, scope: TenantScope, *, user_id: int, notification_id: int
) -> None:
    conn.execute(
        update(notifications)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.user_id == user_id,
            notifications.c.id == notification_id,
            notifications.c.read_at.is_(None),
        )
        .values(read_at=datetime.now(timezone.utc))
    )


def mark_all_read(
    conn: Connection, scope: TenantScope, *, user_id: int
) -> int:
    """Returns the number of rows flipped."""

    result = conn.execute(
        update(notifications)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.user_id == user_id,
            notifications.c.read_at.is_(None),
        )
        .values(read_at=datetime.now(timezone.utc))
    )
    return int(result.rowcount or 0)


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------


def list_preferences(
    conn: Connection, scope: TenantScope, *, user_id: int
) -> list[PreferenceRow]:
    """Return one row per category — synthesised defaults for any
    category the user has not explicitly customised."""

    stored = {
        str(r.category): PreferenceRow(
            user_id=int(r.user_id),
            tenant_id=int(r.tenant_id),
            category=str(r.category),
            in_app=bool(r.in_app),
            email=bool(r.email),
        )
        for r in conn.execute(
            select(
                notification_preferences.c.user_id,
                notification_preferences.c.tenant_id,
                notification_preferences.c.category,
                notification_preferences.c.in_app,
                notification_preferences.c.email,
            ).where(
                notification_preferences.c.user_id == user_id,
                notification_preferences.c.tenant_id == scope.tenant_id,
            )
        ).all()
    }
    out: list[PreferenceRow] = []
    for cat in ALL_CATEGORIES:
        if cat in stored:
            out.append(stored[cat])
        else:
            out.append(
                PreferenceRow(
                    user_id=user_id,
                    tenant_id=scope.tenant_id,
                    category=cat,
                    in_app=True,
                    email=True,
                )
            )
    return out


def resolve_preference(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    category: Category,
) -> PreferenceRow:
    """Single-category resolver — defaults to ``(in_app=True, email=True)``
    when no row exists. Used by the delivery worker on every drain so a
    preference flip takes effect within one tick."""

    row = conn.execute(
        select(
            notification_preferences.c.user_id,
            notification_preferences.c.tenant_id,
            notification_preferences.c.category,
            notification_preferences.c.in_app,
            notification_preferences.c.email,
        ).where(
            notification_preferences.c.user_id == user_id,
            notification_preferences.c.tenant_id == scope.tenant_id,
            notification_preferences.c.category == category,
        )
    ).first()
    if row is None:
        return PreferenceRow(
            user_id=user_id,
            tenant_id=scope.tenant_id,
            category=category,
            in_app=True,
            email=True,
        )
    return PreferenceRow(
        user_id=int(row.user_id),
        tenant_id=int(row.tenant_id),
        category=str(row.category),
        in_app=bool(row.in_app),
        email=bool(row.email),
    )


def set_preference(
    conn: Connection,
    scope: TenantScope,
    *,
    user_id: int,
    category: Category,
    in_app: bool,
    email: bool,
) -> None:
    """Upsert (composite PK) — manual because SQLAlchemy's
    ``insert(...).on_conflict_do_update`` would tie us to psycopg2."""

    existing = conn.execute(
        select(notification_preferences.c.user_id).where(
            notification_preferences.c.user_id == user_id,
            notification_preferences.c.tenant_id == scope.tenant_id,
            notification_preferences.c.category == category,
        )
    ).first()
    now = datetime.now(timezone.utc)
    if existing is None:
        conn.execute(
            insert(notification_preferences).values(
                user_id=user_id,
                tenant_id=scope.tenant_id,
                category=category,
                in_app=in_app,
                email=email,
                updated_at=now,
            )
        )
    else:
        conn.execute(
            update(notification_preferences)
            .where(
                notification_preferences.c.user_id == user_id,
                notification_preferences.c.tenant_id == scope.tenant_id,
                notification_preferences.c.category == category,
            )
            .values(in_app=in_app, email=email, updated_at=now)
        )


# ---------------------------------------------------------------------------
# Delivery worker support
# ---------------------------------------------------------------------------


def list_pending_email(
    conn: Connection,
    scope: TenantScope,
    *,
    limit: int = 200,
    max_attempts: int = 3,
) -> list[NotificationRow]:
    """Notifications that are unsent and haven't exhausted retries.

    The delivery worker re-resolves the preference per row before
    actually sending — the preference flag is **authoritative** (the
    P20 red line), and we don't want a stale snapshot of preferences
    here to override a fresh "no email please" flip.
    """

    rows = conn.execute(
        select(*_NOTIFICATION_COLS)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.email_sent_at.is_(None),
            notifications.c.email_attempts < max_attempts,
        )
        .order_by(notifications.c.id.asc())
        .limit(limit)
    ).all()
    return [_row_to_notification(r) for r in rows]


def mark_email_sent(
    conn: Connection, scope: TenantScope, *, notification_id: int
) -> None:
    conn.execute(
        update(notifications)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.id == notification_id,
        )
        .values(
            email_sent_at=datetime.now(timezone.utc),
            email_attempts=notifications.c.email_attempts + 1,
            email_failed_at=None,
            email_error=None,
        )
    )


def mark_email_failed(
    conn: Connection,
    scope: TenantScope,
    *,
    notification_id: int,
    error: str,
) -> None:
    conn.execute(
        update(notifications)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.id == notification_id,
        )
        .values(
            email_attempts=notifications.c.email_attempts + 1,
            email_failed_at=datetime.now(timezone.utc),
            email_error=error[:500],
        )
    )


def mark_email_skipped(
    conn: Connection,
    scope: TenantScope,
    *,
    notification_id: int,
    reason: str,
) -> None:
    """Stamp the row as "we deliberately did not email" so the worker
    doesn't re-pick it. Honours the preference red line: a skip
    triggered by ``email=false`` ends here, not in the email
    provider's send path."""

    conn.execute(
        update(notifications)
        .where(
            notifications.c.tenant_id == scope.tenant_id,
            notifications.c.id == notification_id,
        )
        .values(
            email_sent_at=datetime.now(timezone.utc),
            email_attempts=notifications.c.email_attempts + 1,
            email_error=f"skipped: {reason[:200]}",
        )
    )
