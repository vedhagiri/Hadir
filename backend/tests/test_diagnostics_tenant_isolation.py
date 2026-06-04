"""Regression test for the diagnostics cross-tenant leak (Issue #1).

The Frame Diagnostics ring (`maugood.diagnostics.recorder`) is a
process-global deque holding events from EVERY tenant's capture
workers. Before the fix, `GET /api/diagnostics/events` returned the
whole ring to any tenant Admin, leaking other tenants'
`tenant_id` / `camera_name` / anomaly metrics.

This test seeds the ring with one own-tenant event (tenant 1, the
admin_user's tenant) and one foreign-tenant event (tenant 999), then
asserts the endpoint returns only the caller's tenant. It FAILS on the
pre-fix code (foreign event leaks) and PASSES once `snapshot()` filters
by `tenant_id` and the router passes the caller's scope.
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from maugood.diagnostics import recorder
from maugood.diagnostics.recorder import FrameDiagnosticEvent


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _seed_two_tenants() -> None:
    """Put one own (tenant 1) + one foreign (tenant 999) event in the ring."""
    recorder.set_enabled(True)
    recorder.clear()
    now = time.time()
    with recorder._lock:  # test-only direct seed; bypasses cooldown
        recorder._ring.append(FrameDiagnosticEvent(
            ts=now, tenant_id=1, camera_id=11, camera_name="Own Cam",
            kind="frame_slow", reason="own-tenant event", metrics={},
        ))
        recorder._ring.append(FrameDiagnosticEvent(
            ts=now, tenant_id=999, camera_id=77, camera_name="Foreign Cam",
            kind="frame_slow", reason="foreign-tenant event", metrics={},
        ))


def test_diagnostics_events_do_not_leak_other_tenants(
    client: TestClient, admin_user: dict
) -> None:
    try:
        _seed_two_tenants()
        _login(client, admin_user)
        resp = client.get("/api/diagnostics/events")
        assert resp.status_code == 200, resp.text
        events = resp.json()["events"]
        tenant_ids = {e["tenant_id"] for e in events}
        cam_names = {e["camera_name"] for e in events}

        # Caller is tenant 1 → must see its own event...
        assert 1 in tenant_ids, f"own-tenant event missing: {tenant_ids}"
        # ...and must NEVER see tenant 999's event (the leak).
        assert 999 not in tenant_ids, (
            f"CROSS-TENANT LEAK: foreign tenant events visible: {tenant_ids}"
        )
        assert "Foreign Cam" not in cam_names, (
            f"CROSS-TENANT LEAK: foreign camera name visible: {cam_names}"
        )
    finally:
        recorder.set_enabled(False)
        recorder.clear()


def test_diagnostics_state_count_is_tenant_scoped(
    client: TestClient, admin_user: dict
) -> None:
    """`/state` event_count must also count only the caller's tenant."""
    try:
        _seed_two_tenants()
        _login(client, admin_user)
        resp = client.get("/api/diagnostics/state")
        assert resp.status_code == 200, resp.text
        # Only the single tenant-1 event should be counted, not both.
        assert resp.json()["event_count"] == 1, resp.text
    finally:
        recorder.set_enabled(False)
        recorder.clear()
