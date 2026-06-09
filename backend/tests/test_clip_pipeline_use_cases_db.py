"""DB-backed per-tenant clip-pipeline use-case enable set (migration 0073).

Covers the UI-controllable per-tenant setting that overrides the env-only
``MAUGOOD_CLIP_PIPELINE_USE_CASES`` knob:

* ``GET /api/system/clip-pipeline-config`` returns the EFFECTIVE set
  (DB value if set, else env/default).
* ``PUT`` round-trips; normalises order + dedupes; empty array allowed;
  invalid item → 400.
* Admin-only (Employee → 403 on both GET + PUT).
* The runtime resolver ``enabled_use_cases_for`` honours the DB value;
  ``submit_batch`` for that tenant queues only the enabled UCs.
* A NULL column falls back to the env/default.
* Per-tenant isolation: tenant A's DB value doesn't change tenant B's
  effective set.
"""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy import update as sql_update
from sqlalchemy.engine import Engine

import maugood.clip_pipeline.pipeline as pipeline_mod
from maugood.db import audit_log, tenant_settings
from maugood.tenants.scope import TenantScope

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _reset_column(admin_engine: Engine, tenant_id: int = 1) -> None:
    """Set the column back to NULL ("inherit") + drop the resolver cache
    so tests don't bleed into each other."""

    with admin_engine.begin() as conn:
        conn.execute(
            sql_update(tenant_settings)
            .where(tenant_settings.c.tenant_id == tenant_id)
            .values(clip_pipeline_use_cases=None)
        )
    pipeline_mod.invalidate_use_cases_cache(None)


# ---------------------------------------------------------------------------
# Endpoint round-trips
# ---------------------------------------------------------------------------


def test_get_returns_env_default_when_null(
    client: TestClient, admin_user: dict, admin_engine: Engine, monkeypatch
) -> None:
    _reset_column(admin_engine)
    monkeypatch.delenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", raising=False)
    importlib.reload(pipeline_mod)
    _login(client, admin_user)
    resp = client.get("/api/system/clip-pipeline-config")
    assert resp.status_code == 200, resp.text
    # NULL column → env unset → default both.
    assert resp.json()["use_cases"] == ["uc1", "uc2"]
    _reset_column(admin_engine)


def test_put_then_get_round_trips(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _reset_column(admin_engine)
    _login(client, admin_user)
    resp = client.put(
        "/api/system/clip-pipeline-config", json={"use_cases": ["uc1"]}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["use_cases"] == ["uc1"]

    resp2 = client.get("/api/system/clip-pipeline-config")
    assert resp2.status_code == 200
    assert resp2.json()["use_cases"] == ["uc1"]
    _reset_column(admin_engine)


def test_put_normalizes_order_and_dedupes(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _reset_column(admin_engine)
    _login(client, admin_user)
    resp = client.put(
        "/api/system/clip-pipeline-config",
        json={"use_cases": ["uc2", "uc1", "uc1"]},
    )
    assert resp.status_code == 200, resp.text
    # Deduped + order-normalized to canonical (uc1, uc2).
    assert resp.json()["use_cases"] == ["uc1", "uc2"]
    _reset_column(admin_engine)


def test_put_empty_array_allowed(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _reset_column(admin_engine)
    _login(client, admin_user)
    resp = client.put(
        "/api/system/clip-pipeline-config", json={"use_cases": []}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["use_cases"] == []

    # GET reflects the empty set — an empty (non-NULL) column means
    # "none run", which must NOT fall back to the env/default.
    resp2 = client.get("/api/system/clip-pipeline-config")
    assert resp2.json()["use_cases"] == []
    _reset_column(admin_engine)


def test_put_rejects_invalid_item(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _reset_column(admin_engine)
    _login(client, admin_user)
    resp = client.put(
        "/api/system/clip-pipeline-config",
        json={"use_cases": ["uc1", "uc9"]},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == "use_cases"
    _reset_column(admin_engine)


def test_put_audits_before_after(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _reset_column(admin_engine)
    _login(client, admin_user)
    resp = client.put(
        "/api/system/clip-pipeline-config", json={"use_cases": ["uc2"]}
    )
    assert resp.status_code == 200, resp.text

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(audit_log.c.action == "system.clip_pipeline_config.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before is not None
    assert row.after == {"use_cases": ["uc2"]}
    _reset_column(admin_engine)


def test_endpoints_admin_only(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    assert client.get("/api/system/clip-pipeline-config").status_code == 403
    resp = client.put(
        "/api/system/clip-pipeline-config", json={"use_cases": ["uc1"]}
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Runtime resolver + submit_batch gating
# ---------------------------------------------------------------------------


def _fresh_pipeline(monkeypatch):
    """Reload pipeline with both UCs enabled at the env layer + a
    stubbed crop handler, started. The DB value (if any) overrides env
    at submit time via ``enabled_use_cases_for``."""

    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", "uc1,uc2")
    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY", "1")
    mod = importlib.reload(pipeline_mod)
    pipe = mod.ClipPipeline()
    pipe._handle_crop = lambda job: None  # type: ignore[assignment]
    pipe.start()
    return mod, pipe


_SCOPE = TenantScope(tenant_id=1, tenant_schema="main")


def test_db_value_drives_submit_batch(
    admin_engine: Engine, monkeypatch
) -> None:
    """PUT uc1 only (via DB) → submit_batch for that tenant queues only
    uc1 even though env enables both and both stages run."""

    mod, pipe = _fresh_pipeline(monkeypatch)
    try:
        # Set the DB column for tenant 1 to uc1 only.
        with admin_engine.begin() as conn:
            conn.execute(
                sql_update(tenant_settings)
                .where(tenant_settings.c.tenant_id == 1)
                .values(clip_pipeline_use_cases=["uc1"])
            )
        mod.invalidate_use_cases_cache(None)

        # Both cropping stages exist (started from env); the DB
        # value gates at submit time.
        assert set(pipe._cropping_by_uc.keys()) == {"uc1", "uc2"}

        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[5001],
            use_cases=["uc1", "uc2"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        # Only uc1 queues — uc2 dropped by the per-tenant resolver.
        assert batch.queued_jobs == 1
        assert set(batch.per_uc.keys()) == {"uc1"}
    finally:
        pipe.stop()
        _reset_column(admin_engine)
        importlib.reload(pipeline_mod)


def test_db_empty_array_queues_nothing(
    admin_engine: Engine, monkeypatch
) -> None:
    mod, pipe = _fresh_pipeline(monkeypatch)
    try:
        with admin_engine.begin() as conn:
            conn.execute(
                sql_update(tenant_settings)
                .where(tenant_settings.c.tenant_id == 1)
                .values(clip_pipeline_use_cases=[])
            )
        mod.invalidate_use_cases_cache(None)

        batch = pipe.submit_batch(
            scope=_SCOPE,
            clip_ids=[5002],
            use_cases=["uc1", "uc2"],
            skip_existing=False,
            submitted_by_user_id=None,
            submitted_by_email="test",
        )
        assert batch.queued_jobs == 0
        assert batch.per_uc == {}
    finally:
        pipe.stop()
        _reset_column(admin_engine)
        importlib.reload(pipeline_mod)


def test_null_column_falls_back_to_env(
    admin_engine: Engine, monkeypatch
) -> None:
    """When the column is NULL the resolver uses the env-derived set."""

    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", "uc2")
    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY", "1")
    mod = importlib.reload(pipeline_mod)
    try:
        with admin_engine.begin() as conn:
            conn.execute(
                sql_update(tenant_settings)
                .where(tenant_settings.c.tenant_id == 1)
                .values(clip_pipeline_use_cases=None)
            )
        mod.invalidate_use_cases_cache(None)

        got = mod.enabled_use_cases_for(_SCOPE)
        assert got == ("uc2",)
    finally:
        _reset_column(admin_engine)
        importlib.reload(pipeline_mod)


def test_per_tenant_isolation(admin_engine: Engine, monkeypatch) -> None:
    """Tenant 1's DB value (uc1) doesn't affect a tenant whose column is
    NULL — that tenant still sees the env/default set."""

    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_USE_CASES", "uc1,uc2")
    monkeypatch.setenv("MAUGOOD_CLIP_PIPELINE_DISABLE_RECOVERY", "1")
    mod = importlib.reload(pipeline_mod)
    try:
        with admin_engine.begin() as conn:
            conn.execute(
                sql_update(tenant_settings)
                .where(tenant_settings.c.tenant_id == 1)
                .values(clip_pipeline_use_cases=["uc1"])
            )
        mod.invalidate_use_cases_cache(None)

        # Tenant 1 (main) sees the DB value.
        scope_a = TenantScope(tenant_id=1, tenant_schema="main")
        assert mod.enabled_use_cases_for(scope_a) == ("uc1",)

        # A bare tenant_id with no schema can't read the DB → env default.
        # This stands in for "another tenant whose column is NULL": the
        # resolver returns the env/default set, NOT tenant 1's value.
        assert mod.enabled_use_cases_for(999) == ("uc1", "uc2")
    finally:
        _reset_column(admin_engine)
        importlib.reload(pipeline_mod)
