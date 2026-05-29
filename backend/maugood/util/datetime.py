"""Tenant-aware datetime formatting (migration 0068).

Backend mirror of ``frontend/src/util/datetime.ts``. Used by the
human-readable report renderers (PDF, Excel) so a date or time
appearing in an export reads identically to its UI counterpart
(same timezone, same DD/MM/YYYY vs MM/DD/YYYY, same 12h vs 24h).

ERP exports (CSV / JSON file-drop in ``maugood/erp_export/``)
intentionally do NOT route through this — they're machine-readable
feeds with a documented schema (``docs/erp-file-drop-schema.md``)
that downstream integrations parse. Keeping those on ISO 8601
preserves the contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.engine import Connection

from maugood.db import tenant_settings


DateFormat = Literal["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]
TimeFormat = Literal["12h", "24h"]


@dataclass(frozen=True, slots=True)
class TenantFormatter:
    """Formatter built from a tenant's ``(timezone, date_format,
    time_format)`` choice. Pure — does not touch the DB."""

    timezone: str
    date_format: DateFormat
    time_format: TimeFormat

    @property
    def _tzinfo(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError:
            return ZoneInfo("Asia/Muscat")

    def _to_local(self, value: datetime) -> datetime:
        """UTC-or-naive → tenant-local. Naive timestamps are treated
        as UTC (matches every DateTime(timezone=True) column at
        rest in this database — the engine stores TIMESTAMPTZ)."""
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(self._tzinfo)

    # --- Date ---------------------------------------------------------------

    def format_date(self, value: Optional[date | datetime]) -> str:
        if value is None:
            return ""
        if isinstance(value, datetime):
            d = self._to_local(value).date()
        else:
            d = value
        if self.date_format == "DD/MM/YYYY":
            return f"{d.day:02d}/{d.month:02d}/{d.year:04d}"
        if self.date_format == "MM/DD/YYYY":
            return f"{d.month:02d}/{d.day:02d}/{d.year:04d}"
        # YYYY-MM-DD
        return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"

    # --- Time ---------------------------------------------------------------

    def format_time(
        self,
        value: Optional[time | datetime],
        *,
        with_seconds: bool = False,
    ) -> str:
        if value is None:
            return ""
        if isinstance(value, datetime):
            t = self._to_local(value).time()
        else:
            t = value
        if self.time_format == "24h":
            if with_seconds:
                return f"{t.hour:02d}:{t.minute:02d}:{t.second:02d}"
            return f"{t.hour:02d}:{t.minute:02d}"
        # 12h
        hour = t.hour % 12
        if hour == 0:
            hour = 12
        ampm = "AM" if t.hour < 12 else "PM"
        if with_seconds:
            return f"{hour:02d}:{t.minute:02d}:{t.second:02d} {ampm}"
        return f"{hour:02d}:{t.minute:02d} {ampm}"

    # --- Combined -----------------------------------------------------------

    def format_datetime(
        self,
        value: Optional[datetime],
        *,
        with_seconds: bool = False,
    ) -> str:
        if value is None:
            return ""
        local = self._to_local(value)
        return f"{self.format_date(local.date())} {self.format_time(local.time(), with_seconds=with_seconds)}"


def load_tenant_formatter(conn: Connection, tenant_id: int) -> TenantFormatter:
    """Build a {@link TenantFormatter} from the tenant_settings row.
    Falls back to seed defaults if the row hasn't been materialised
    yet — matches the ``/api/auth/me`` behaviour."""

    row = conn.execute(
        select(
            tenant_settings.c.timezone,
            tenant_settings.c.date_format,
            tenant_settings.c.time_format,
        ).where(tenant_settings.c.tenant_id == tenant_id)
    ).first()
    if row is None:
        return TenantFormatter(
            timezone="Asia/Muscat",
            date_format="DD/MM/YYYY",
            time_format="24h",
        )
    return TenantFormatter(
        timezone=str(row.timezone) if row.timezone else "Asia/Muscat",
        date_format=(
            str(row.date_format) if row.date_format else "DD/MM/YYYY"  # type: ignore[arg-type]
        ),  # type: ignore[arg-type]
        time_format=(
            str(row.time_format) if row.time_format else "24h"  # type: ignore[arg-type]
        ),  # type: ignore[arg-type]
    )
