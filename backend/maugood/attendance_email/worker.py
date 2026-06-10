"""Delivery drain for attendance status emails.

Invoked by the notification email worker's 30-second tick, inside the
tenant's ``tenant_context``. Per tenant:

1. Run the yesterday-absent sweep (idempotent).
2. Pull pending ``attendance_email_log`` rows (attempts < 3).
3. Re-check the tenant toggle for each row's status — a flip after
   enqueue suppresses delivery (row marked skipped, reason recorded).
4. Re-read the employee + attendance row at delivery time so the email
   carries the freshest values; render the approved template; dispatch
   via the tenant's Settings → Email provider.
5. ``sent_at`` on success (with the emailed snapshot persisted to the
   log row), ``failed_at`` + ``last_error`` + attempt bump on failure —
   the next tick retries until 3 attempts.

If Settings → Email is disabled, pending rows are marked skipped so
the queue drains (same contract as the user-notification worker).
"""

from __future__ import annotations

import logging
import mimetypes
from datetime import date, datetime, time as dtime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.engine import Connection

from maugood.attendance.repository import load_tenant_settings, local_tz_for
from maugood.attendance_email import producer, repository as repo
from maugood.db import get_engine, shift_policies, tenant_branding, tenant_settings
from maugood.emailing.providers import EmailMessage, SenderConfig, get_sender
from maugood.emailing.render import render_attendance_email_html
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

_STATUS_TITLES = {
    "present": "Present",
    "late": "Late Arrival",
    "absent": "Absent",
}
_CATEGORY_LABELS = {
    "present": "Present notifications",
    "late": "Late notifications",
    "absent": "Absent notifications",
}

# Static PNG assets shipped with the backend — referenced from the
# email HTML via cid: (Gmail/Outlook strip inline SVG + data: URIs,
# so CID inline attachments are the only portable embedding).
_ASSET_DIR = Path(__file__).resolve().parent.parent / "emailing" / "templates" / "assets"


@lru_cache(maxsize=8)
def _asset_bytes(name: str) -> Optional[bytes]:
    try:
        return (_ASSET_DIR / name).read_bytes()
    except OSError:
        logger.warning("email asset missing: %s", name)
        return None


def _fmt_time(value: Optional[dtime], time_format: str) -> Optional[str]:
    if value is None:
        return None
    if time_format == "24h":
        return value.strftime("%H:%M")
    return value.strftime("%I:%M %p").lstrip("0")


def _fmt_total(total_minutes: Optional[int]) -> Optional[str]:
    if total_minutes is None:
        return None
    return f"{total_minutes // 60}h {total_minutes % 60:02d}m"


def _time_format_for(conn: Connection, scope: TenantScope) -> str:
    row = conn.execute(
        select(tenant_settings.c.time_format).where(
            tenant_settings.c.tenant_id == scope.tenant_id
        )
    ).first()
    return str(row.time_format) if row is not None else "12h"


def _shift_info(
    conn: Connection, scope: TenantScope, policy_id: Optional[int]
) -> dict:
    """Best-effort (start, end, grace) from the policy config.

    Fixed/Ramadan carry ``start``/``end``; Custom may nest under
    ``inner``; Flex has windows, not a single start — every key is
    optional and the template omits missing rows.
    """

    out: dict = {"start": None, "end": None, "grace_minutes": None}
    if policy_id is None:
        return out
    row = conn.execute(
        select(shift_policies.c.config).where(
            shift_policies.c.tenant_id == scope.tenant_id,
            shift_policies.c.id == policy_id,
        )
    ).first()
    if row is None or not isinstance(row.config, dict):
        return out
    cfg = row.config
    inner = cfg.get("inner") if isinstance(cfg.get("inner"), dict) else {}

    def _hhmm(value: object) -> Optional[dtime]:
        if not isinstance(value, str) or ":" not in value:
            return None
        try:
            hh, mm = value.split(":")[:2]
            return dtime(int(hh), int(mm))
        except (ValueError, TypeError):
            return None

    out["start"] = _hhmm(cfg.get("start") or inner.get("start"))
    out["end"] = _hhmm(cfg.get("end") or inner.get("end"))
    grace = cfg.get("grace_minutes", inner.get("grace_minutes"))
    out["grace_minutes"] = int(grace) if isinstance(grace, (int, float)) else None
    return out


def _late_minutes(
    in_time: Optional[dtime], shift_start: Optional[dtime], the_date: date
) -> Optional[int]:
    if in_time is None or shift_start is None:
        return None
    delta = datetime.combine(the_date, in_time) - datetime.combine(
        the_date, shift_start
    )
    minutes = int(delta.total_seconds() // 60)
    return minutes if minutes > 0 else None


def _tenant_logo(
    conn: Connection, scope: TenantScope
) -> Optional[tuple[str, bytes]]:
    """(mime, bytes) of the tenant's branding logo, or None.

    SVG logos are skipped — mail clients don't render SVG even as an
    inline attachment; the header falls back to the tenant name.
    """

    row = conn.execute(
        select(tenant_branding.c.logo_path).where(
            tenant_branding.c.tenant_id == scope.tenant_id
        )
    ).first()
    if row is None or not row.logo_path:
        return None
    path = Path(str(row.logo_path))
    mime, _ = mimetypes.guess_type(path.name)
    if not mime or not mime.startswith("image/") or mime == "image/svg+xml":
        return None
    try:
        return mime, path.read_bytes()
    except OSError:
        return None


def _build_message(
    *,
    sender: SenderConfig,
    tenant: dict,
    tenant_logo: Optional[tuple[str, bytes]],
    recipient: str,
    recipient_kind: str,
    recipient_name: str,
    status: str,
    the_date: date,
    ctx: dict,
    time_format: str,
    shift: dict,
) -> tuple[EmailMessage, dict]:
    """Render one attendance email. Returns (message, sent_snapshot)."""

    title = _STATUS_TITLES[status]
    date_label = the_date.strftime("%A, %-d %B %Y")
    date_short = the_date.strftime("%a, %-d %B %Y")
    in_label = _fmt_time(ctx["in_time"], time_format)
    out_label = _fmt_time(ctx["out_time"], time_format)
    total_label = _fmt_total(ctx["total_minutes"])
    late_min = (
        _late_minutes(ctx["in_time"], shift["start"], the_date)
        if status == "late"
        else None
    )
    shift_label = None
    if shift["start"] is not None and shift["end"] is not None:
        shift_label = (
            f"{_fmt_time(shift['start'], time_format)} – "
            f"{_fmt_time(shift['end'], time_format)}"
        )
    grace_label = (
        f"{shift['grace_minutes']} minutes"
        if status == "late" and shift["grace_minutes"]
        else None
    )

    if status == "late" and late_min:
        subject = f"Attendance: Late (+{late_min} min) — {date_short}"
    else:
        subject = f"Attendance: {title} — {date_short}"
    if recipient_kind == "manager":
        subject = (
            f"Team attendance: {ctx['employee_name']} — {title} — {date_short}"
        )

    inline_images: list[tuple[str, str, bytes]] = []
    icon = _asset_bytes(f"icon_{status}.png")
    icon_cid = None
    if icon:
        icon_cid = "status-icon"
        inline_images.append((icon_cid, "image/png", icon))
    logo_cid = None
    if tenant_logo is not None:
        logo_cid = "tenant-logo"
        inline_images.append((logo_cid, tenant_logo[0], tenant_logo[1]))
    brand = _asset_bytes("maugoodai_logo.png")
    brand_cid = None
    if brand:
        brand_cid = "maugood-logo"
        inline_images.append((brand_cid, "image/png", brand))

    html = render_attendance_email_html(
        context={
            "status": status,
            "tenant": tenant,
            "logo_data_url": None,
            "icon_cid": icon_cid,
            "logo_cid": logo_cid,
            "brand_cid": brand_cid,
            "recipient_kind": recipient_kind,
            "recipient_name": recipient_name,
            "employee": {
                "name": ctx["employee_name"],
                "code": ctx["employee_code"],
                "department": ctx["department_name"],
            },
            "date_label": date_label,
            "date_short": date_short,
            "check_in_label": in_label,
            "check_out_label": out_label,
            "total_label": total_label,
            "late_minutes": late_min,
            "shift_label": shift_label,
            "grace_label": grace_label,
            "category_label": _CATEGORY_LABELS[status],
            "app_version": None,
        }
    )
    text_lines = [
        (
            f"Team attendance — {ctx['employee_name']}: {title} on {date_label}"
            if recipient_kind == "manager"
            else f"{title} — attendance for {date_label}"
        ),
        "",
        f"Employee: {ctx['employee_name']} ({ctx['employee_code']})",
        f"Date: {date_label}",
        f"Status: {title}",
        f"Check-in: {in_label or 'not recorded'}",
        f"Check-out: {out_label or 'not recorded'}",
    ]
    if total_label:
        text_lines.append(f"Total hours: {total_label}")
    message = EmailMessage(
        subject=subject,
        html=html,
        text="\n".join(text_lines),
        to=(recipient,),
        from_address=sender.from_address or "no-reply@example.com",
        from_name=sender.from_name,
        inline_images=tuple(inline_images),
    )
    snapshot = {
        "subject": subject,
        "in_time": ctx["in_time"],
        "out_time": ctx["out_time"],
        "late_minutes": late_min,
        "total_minutes": ctx["total_minutes"],
    }
    return message, snapshot


def drain_attendance_emails(*, scope: TenantScope) -> dict:
    """Sweep + drain for one tenant. Caller sets ``tenant_context``.

    Returns counts for diagnostics/tests.
    """

    from maugood.notifications.worker import (  # noqa: PLC0415
        _read_sender_config,
        _tenant_summary,
    )

    counts = {"queued_absent": 0, "sent": 0, "skipped": 0, "failed": 0}
    engine = get_engine()

    with engine.begin() as conn:
        settings = load_tenant_settings(conn, scope)
        tz = local_tz_for(settings)
        counts["queued_absent"] = producer.sweep_absent_yesterday(
            conn, scope, tz=tz
        )
        counts["queued_absent"] += producer.sweep_absent_after_shift(
            conn, scope, tz=tz
        )
        config = repo.load_config(conn, scope)
        pending = repo.list_pending(conn, scope)
        if not pending:
            return counts
        sender = _read_sender_config(conn, tenant_id=scope.tenant_id)
        tenant = _tenant_summary(conn, tenant_id=scope.tenant_id)
        if not (tenant.get("name") or "").strip():
            tenant["name"] = "Maugood"
        tenant_logo = _tenant_logo(conn, scope)
        time_format = _time_format_for(conn, scope)

    if sender is None:
        # Settings → Email disabled — drain the queue as skipped so
        # stale rows don't fire weeks later when email turns on.
        with engine.begin() as conn:
            for p in pending:
                repo.mark_skipped(
                    conn, scope, row_id=p.id, reason="email_config_disabled"
                )
                counts["skipped"] += 1
        return counts

    sender_obj = get_sender(sender)
    for p in pending:
        try:
            with engine.begin() as conn:
                # Re-check the toggle per row — the P20-style red line:
                # a flip after enqueue takes effect at delivery time.
                config = repo.load_config(conn, scope)
                if not config.get(p.status, False):
                    repo.mark_skipped(
                        conn, scope, row_id=p.id, reason="toggle_off"
                    )
                    counts["skipped"] += 1
                    continue
                ctx = repo.delivery_context(
                    conn, scope, employee_id=p.employee_id, the_date=p.date
                )
                if ctx is None or ctx["employee_status"] != "active":
                    repo.mark_skipped(
                        conn, scope, row_id=p.id, reason="employee_not_active"
                    )
                    counts["skipped"] += 1
                    continue
                if p.recipient_kind == "manager":
                    manager = repo.resolve_manager(
                        conn, scope, employee_id=p.employee_id
                    )
                    if manager is None:
                        repo.mark_skipped(
                            conn, scope, row_id=p.id, reason="no_manager"
                        )
                        counts["skipped"] += 1
                        continue
                    recipient = manager["email"]
                    recipient_name = manager["name"]
                else:
                    recipient = ctx["employee_email"]
                    recipient_name = ctx["employee_name"]
                    if not recipient:
                        repo.mark_skipped(
                            conn, scope, row_id=p.id, reason="no_employee_email"
                        )
                        counts["skipped"] += 1
                        continue
                if recipient.lower().endswith("@maugood.local"):
                    # Placeholder / PDPL-redacted addresses are never
                    # real mailboxes — sending them only burns the
                    # provider's bounce budget and sender reputation.
                    repo.mark_skipped(
                        conn, scope, row_id=p.id, reason="placeholder_email"
                    )
                    counts["skipped"] += 1
                    continue
                shift = _shift_info(conn, scope, ctx["policy_id"])

            message, snapshot = _build_message(
                sender=sender,
                tenant=tenant,
                tenant_logo=tenant_logo,
                recipient=recipient,
                recipient_kind=p.recipient_kind,
                recipient_name=recipient_name,
                status=p.status,
                the_date=p.date,
                ctx=ctx,
                time_format=time_format,
                shift=shift,
            )
            sender_obj.send(message)
        except Exception as exc:  # noqa: BLE001
            with engine.begin() as conn:
                repo.mark_failed(
                    conn,
                    scope,
                    row_id=p.id,
                    error=type(exc).__name__ + ": " + str(exc),
                )
            counts["failed"] += 1
            continue

        with engine.begin() as conn:
            repo.mark_sent(
                conn,
                scope,
                row_id=p.id,
                recipient_email=recipient,
                subject=snapshot["subject"],
                in_time=snapshot["in_time"],
                out_time=snapshot["out_time"],
                late_minutes=snapshot["late_minutes"],
                total_minutes=snapshot["total_minutes"],
            )
        counts["sent"] += 1
        try:
            from maugood.metrics import observe_email_send  # noqa: PLC0415

            observe_email_send(
                scope.tenant_id, provider=sender.provider, status="sent"
            )
        except Exception:  # noqa: BLE001
            pass

    return counts
