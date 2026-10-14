"""Overnight shifts (end before start, e.g. 16:00 → 02:03) stay "open"
for the whole of today, so today isn't shown as absent — or emailed as
absent — before the shift has even started."""

from __future__ import annotations

import secrets
from datetime import datetime, time, timezone

from sqlalchemy import delete, insert
from sqlalchemy.engine import Engine

from maugood.attendance.repository import policy_shift_end_times
from maugood.db import shift_policies, tenant_context
from maugood.tenants.scope import TenantScope


def _policy(admin_engine: Engine, ptype: str, config: dict) -> int:
    with admin_engine.begin() as conn:
        return int(
            conn.execute(
                insert(shift_policies)
                .values(
                    tenant_id=1,
                    name=f"overnight-test-{secrets.token_hex(3)}",
                    type=ptype,
                    config=config,
                    active_from=datetime.now(timezone.utc).date(),
                )
                .returning(shift_policies.c.id)
            ).scalar()
        )


def test_overnight_and_day_shift_end_times(admin_engine: Engine) -> None:
    ids = {
        "overnight": _policy(admin_engine, "Fixed", {"start": "16:00", "end": "02:03", "grace_minutes": 30}),
        "day": _policy(admin_engine, "Fixed", {"start": "07:30", "end": "15:30", "grace_minutes": 15}),
        "flex_overnight": _policy(
            admin_engine,
            "Flex",
            {"in_window_start": "20:00", "in_window_end": "22:00", "out_window_start": "04:00", "out_window_end": "06:00"},
        ),
        "zero": _policy(admin_engine, "Fixed", {"start": "00:00", "end": "00:00", "grace_minutes": 0}),
    }
    try:
        with tenant_context("main"), admin_engine.begin() as conn:
            got = policy_shift_end_times(conn, TenantScope(tenant_id=1), list(ids.values()))
        assert got[ids["overnight"]] == time.max  # open all of today
        assert got[ids["flex_overnight"]] == time.max
        assert got[ids["day"]] == time(15, 30)  # unchanged
        assert got[ids["zero"]] == time(0, 0)  # zero-length isn't overnight
    finally:
        with admin_engine.begin() as conn:
            conn.execute(delete(shift_policies).where(shift_policies.c.id.in_(list(ids.values()))))
