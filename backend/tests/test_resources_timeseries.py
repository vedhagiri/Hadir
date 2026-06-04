"""P29 — Resources tab live chart + top-processes coverage.

Verifies:

* The in-memory ring buffer accepts samples + the snapshot filter on
  ``since_ts`` works.
* The ``/timeseries`` endpoint returns the expected shape, range
  fallback on unknown values, and respects the look-back window.
* ``/processes`` returns at least one row (the test runner's own
  Python process) and exposes ``swap_supported`` when running on
  Linux with ``/proc`` available.
* Both endpoints are Admin-only.
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from maugood.observability import timeseries as ts_buffer


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _seed_samples(n: int, base_ts: float) -> None:
    samples = []
    for i in range(n):
        samples.append(
            ts_buffer.Sample(
                ts=base_ts + i * 10.0,
                cpu_percent=float(i),
                mem_percent=float(50 + i),
                swap_percent=float(i % 100),
                disk_read_mb_s=float(i) / 10,
                disk_write_mb_s=float(i) / 20,
                net_recv_mb_s=float(i) / 5,
            )
        )
    ts_buffer.inject_for_test(samples)


def test_snapshot_returns_seeded_samples() -> None:
    base = time.time() - 300
    _seed_samples(10, base)
    snap = ts_buffer.snapshot()
    assert len(snap) == 10
    assert snap[0].cpu_percent == 0.0
    assert snap[-1].cpu_percent == 9.0


def test_snapshot_filters_by_since_ts() -> None:
    base = time.time() - 300
    _seed_samples(10, base)
    snap = ts_buffer.snapshot(since_ts=base + 50.0)
    assert len(snap) == 5
    assert snap[0].cpu_percent == 5.0


def test_timeseries_endpoint_round_trips(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    base = time.time() - 300
    _seed_samples(5, base)
    resp = client.get(
        "/api/operations/resources/timeseries?range=15m"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["range"] == "15m"
    assert body["sample_interval_s"] == ts_buffer.SAMPLE_INTERVAL_S
    points = body["points"]
    assert len(points) == 5
    p = points[0]
    for key in (
        "ts",
        "cpu_percent",
        "mem_percent",
        "swap_percent",
        "disk_read_mb_s",
        "disk_write_mb_s",
        "net_recv_mb_s",
        "net_sent_mb_s",
        "backend_cpu_percent",
        "backend_mem_mb",
        "mem_used_mb",
        "swap_used_mb",
    ):
        assert key in p


def test_timeseries_unknown_range_falls_back(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _seed_samples(1, time.time())
    resp = client.get(
        "/api/operations/resources/timeseries?range=banana"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["range"] == "1h"


def test_timeseries_requires_admin(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.get("/api/operations/resources/timeseries?range=15m")
    assert resp.status_code in (401, 403)


def test_timeseries_unauthenticated(client: TestClient) -> None:
    resp = client.get("/api/operations/resources/timeseries?range=15m")
    assert resp.status_code == 401


def test_processes_returns_rows(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get(
        "/api/operations/resources/processes?limit=5"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "processes" in body
    assert "swap_supported" in body
    # The test runner itself is a process → at least one row.
    assert len(body["processes"]) >= 1
    row = body["processes"][0]
    for key in (
        "pid",
        "name",
        "cpu_percent",
        "memory_mb",
        "memory_percent",
        "threads",
    ):
        assert key in row


def test_processes_requires_admin(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.get("/api/operations/resources/processes")
    assert resp.status_code in (401, 403)


def test_processes_limit_clamped(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    # limit=0 should fail validation (ge=1).
    resp = client.get("/api/operations/resources/processes?limit=0")
    assert resp.status_code == 422
    # limit=51 should fail (le=50).
    resp = client.get("/api/operations/resources/processes?limit=51")
    assert resp.status_code == 422
