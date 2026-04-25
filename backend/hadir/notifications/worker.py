"""Background email-delivery worker for notifications (v1.0 P20).

APScheduler 30-second tick. Per active tenant:

1. Read ``email_config`` — if disabled, skip the whole tenant.
2. Pull pending notifications (``email_sent_at IS NULL`` and
   ``email_attempts < max_attempts``).
3. For each row, **re-resolve** the per-user preference. If
   ``email=False``, mark the row as skipped (so the worker doesn't
   re-pick it) and move on. The preference flag is authoritative —
   the P20 red line.
4. Otherwise render the email body via the P20 notification
   template and dispatch through the P18 ``get_sender(...)``.
5. Mark ``email_sent_at`` on success or ``email_failed_at`` on
   failure (with attempts incremented). Three attempts then we
   stop trying — the operator can re-trigger by clearing
   ``email_attempts``.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select
from sqlalchemy.engine import Connection

from hadir.branding.constants import (
    DEFAULT_FONT_KEY,
    DEFAULT_PRIMARY_COLOR_KEY,
    FONT_OPTIONS,
)
from hadir.config import get_settings
from hadir.db import (
    email_config as email_config_t,
    get_engine,
    make_admin_engine,
    tenant_branding,
    tenant_context,
    tenants,
    users,
)
from hadir.emailing.providers import (
    EmailMessage,
    SenderConfig,
    get_sender,
)
from hadir.emailing.render import render_notification_email_html
from hadir.emailing.secrets import decrypt_secret
from hadir.notifications.categories import CATEGORY_LABELS
from hadir.notifications.repository import (
    NotificationRow,
    list_pending_email,
    mark_email_failed,
    mark_email_sent,
    mark_email_skipped,
    resolve_preference,
)
from hadir.reporting.pdf import HEX_PALETTE
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_JOB_ID = "notification-email-tick"


def _read_sender_config(conn: Connection, *, tenant_id: int) -> Optional[SenderConfig]:
    row = conn.execute(
        select(
            email_config_t.c.provider,
            email_config_t.c.smtp_host,
            email_config_t.c.smtp_port,
            email_config_t.c.smtp_username,
            email_config_t.c.smtp_password_encrypted,
            email_config_t.c.smtp_use_tls,
            email_config_t.c.graph_tenant_id,
            email_config_t.c.graph_client_id,
            email_config_t.c.graph_client_secret_encrypted,
            email_config_t.c.from_address,
            email_config_t.c.from_name,
            email_config_t.c.enabled,
        ).where(email_config_t.c.tenant_id == tenant_id)
    ).first()
    if row is None or not row.enabled:
        return None
    return SenderConfig(
        provider=str(row.provider),
        smtp_host=str(row.smtp_host or ""),
        smtp_port=int(row.smtp_port),
        smtp_username=str(row.smtp_username or ""),
        smtp_password=decrypt_secret(row.smtp_password_encrypted),
        smtp_use_tls=bool(row.smtp_use_tls),
        graph_tenant_id=str(row.graph_tenant_id or ""),
        graph_client_id=str(row.graph_client_id or ""),
        graph_client_secret=decrypt_secret(
            row.graph_client_secret_encrypted
        ),
        from_address=str(row.from_address or ""),
        from_name=str(row.from_name or ""),
        enabled=True,
    )


def _branding_ctx(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(
            tenant_branding.c.primary_color_key,
            tenant_branding.c.font_key,
        ).where(tenant_branding.c.tenant_id == tenant_id)
    ).first()
    primary = (
        str(row.primary_color_key)
        if row is not None
        else DEFAULT_PRIMARY_COLOR_KEY
    )
    font_key = str(row.font_key) if row is not None else DEFAULT_FONT_KEY
    palette = HEX_PALETTE.get(primary, HEX_PALETTE[DEFAULT_PRIMARY_COLOR_KEY])
    font_family = FONT_OPTIONS.get(font_key, FONT_OPTIONS[DEFAULT_FONT_KEY])
    return {
        "accent_hex": palette["accent"],
        "accent_soft_hex": palette["soft"],
        "font_family": font_family,
    }


def _tenant_summary(conn: Connection, *, tenant_id: int) -> dict:
    row = conn.execute(
        select(tenants.c.id, tenants.c.name, tenants.c.schema_name).where(
            tenants.c.id == tenant_id
        )
    ).first()
    return {
        "id": int(row.id) if row is not None else tenant_id,
        "name": str(row.name) if row is not None else f"Tenant {tenant_id}",
        "schema_name": str(row.schema_name) if row is not None else "",
    }


def _user_email(conn: Connection, *, tenant_id: int, user_id: int) -> Optional[str]:
    row = conn.execute(
        select(users.c.email, users.c.is_active).where(
            users.c.tenant_id == tenant_id,
            users.c.id == user_id,
        )
    ).first()
    if row is None or not row.is_active:
        return None
    raw = row.email
    return str(raw) if raw else None


def _build_message(
    *,
    notification: NotificationRow,
    sender: SenderConfig,
    tenant: dict,
    branding: dict,
    recipient: str,
) -> EmailMessage:
    category_label = CATEGORY_LABELS.get(
        notification.category, notification.category
    )
    html = render_notification_email_html(
        context={
            "tenant": tenant,
            "branding": branding,
            "category_label": category_label,
            "subject": notification.subject,
            "body": notification.body,
            "link_url": notification.link_url,
        }
    )
    text_lines = [notification.subject]
    if notification.body:
        text_lines.append("")
        text_lines.append(notification.body)
    if notification.link_url:
        text_lines.append("")
        text_lines.append(f"Open in Hadir: {notification.link_url}")
    return EmailMessage(
        subject=notification.subject,
        html=html,
        text="\n".join(text_lines),
        to=(recipient,),
        from_address=sender.from_address or "no-reply@example.com",
        from_name=sender.from_name,
    )


def drain_one_tenant(*, scope: TenantScope) -> dict:
    """Drain unsent notifications for one tenant.

    Returns counts dict for diagnostics. Caller is responsible for
    setting ``tenant_context``.
    """

    counts = {"sent": 0, "skipped_pref": 0, "skipped_no_email": 0, "failed": 0}
    engine = get_engine()

    with engine.begin() as conn:
        sender = _read_sender_config(conn, tenant_id=scope.tenant_id)
        tenant = _tenant_summary(conn, tenant_id=scope.tenant_id)
        branding = _branding_ctx(conn, tenant_id=scope.tenant_id)
        pending = list_pending_email(conn, scope, limit=200)

    if not pending:
        return counts

    if sender is None:
        # Tenant doesn't have email enabled; mark every pending row
        # as skipped so the queue stays drained. The in-app
        # notification still sits in the table.
        with engine.begin() as conn:
            for n in pending:
                mark_email_skipped(
                    conn,
                    scope,
                    notification_id=n.id,
                    reason="email_config disabled",
                )
                counts["skipped_no_email"] += 1
        return counts

    sender_obj = get_sender(sender)
    for n in pending:
        # 1) Re-resolve preference per row — a flip during the tick
        # must take effect immediately.
        with engine.begin() as conn:
            pref = resolve_preference(
                conn, scope, user_id=n.user_id, category=n.category  # type: ignore[arg-type]
            )
            recipient = _user_email(
                conn, tenant_id=scope.tenant_id, user_id=n.user_id
            )

        if not pref.email:
            with engine.begin() as conn:
                mark_email_skipped(
                    conn,
                    scope,
                    notification_id=n.id,
                    reason="user_pref_email_off",
                )
            counts["skipped_pref"] += 1
            continue

        if not recipient:
            with engine.begin() as conn:
                mark_email_skipped(
                    conn,
                    scope,
                    notification_id=n.id,
                    reason="no_recipient_email",
                )
            counts["skipped_no_email"] += 1
            continue

        # 2) Build + send.
        try:
            message = _build_message(
                notification=n,
                sender=sender,
                tenant=tenant,
                branding=branding,
                recipient=recipient,
            )
            sender_obj.send(message)
        except Exception as exc:  # noqa: BLE001
            with engine.begin() as conn:
                mark_email_failed(
                    conn,
                    scope,
                    notification_id=n.id,
                    error=type(exc).__name__ + ": " + str(exc),
                )
            counts["failed"] += 1
            continue

        with engine.begin() as conn:
            mark_email_sent(conn, scope, notification_id=n.id)
        counts["sent"] += 1

    return counts


def _tick() -> int:
    fired = 0
    admin_engine = make_admin_engine()
    try:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                tenant_rows = conn.execute(
                    select(tenants.c.id, tenants.c.schema_name).where(
                        tenants.c.status == "active"
                    )
                ).all()
    finally:
        admin_engine.dispose()

    for tr in tenant_rows:
        try:
            scope = TenantScope(tenant_id=int(tr.id))
            with tenant_context(str(tr.schema_name)):
                counts = drain_one_tenant(scope=scope)
            if any(counts.values()):
                logger.info(
                    "notifications drain tenant=%s %s",
                    tr.schema_name,
                    counts,
                )
                fired += counts["sent"]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "notifications drain failed for %s: %s",
                tr.schema_name,
                type(exc).__name__,
            )
    return fired


class NotificationWorker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scheduler: Optional[BackgroundScheduler] = None

    def start(self) -> None:
        with self._lock:
            if self._scheduler is not None:
                return
            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(
                _tick,
                "interval",
                seconds=30,
                id=_JOB_ID,
                replace_existing=True,
            )
            scheduler.start()
            self._scheduler = scheduler
            logger.info("notification email worker started: interval=30s")

    def stop(self) -> None:
        with self._lock:
            if self._scheduler is None:
                return
            self._scheduler.shutdown(wait=False)
            self._scheduler = None


notification_worker = NotificationWorker()
