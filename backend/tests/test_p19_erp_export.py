"""Tests for v1.0 P19 — ERP file-drop export.

Three slices:

1. Pure path resolver — empty input collapses to the tenant root,
   ``..`` traversal raises, absolute paths outside the root raise.
2. CSV + JSON builders — column shape + status reduction +
   metadata block.
3. API end-to-end — config CRUD, run-now writes the file under the
   tenant root and streams the same bytes back, audit row records
   the run.
"""

from __future__ import annotations

import json
from datetime import date, time
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from maugood.config import get_settings
from maugood.db import audit_log, attendance_records, erp_export_config
from maugood.erp_export.builder import (
    CSV_COLUMNS,
    ExportRow,
    filename_for,
    render_csv,
    render_json,
)
from maugood.erp_export.paths import (
    UnsafeOutputPath,
    resolve_safe_dir,
    tenant_root,
)

# Reuse the P13 attendance seed — it lives at tenant_id=1 and gives
# us two employees + three rows for the smoke.
from tests.test_p13_reports import _login, seeded_attendance  # noqa: F401


# ---------------------------------------------------------------------------
# Pure path resolver
# ---------------------------------------------------------------------------


def test_path_resolver_empty_collapses_to_tenant_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MAUGOOD_ERP_EXPORT_ROOT", str(tmp_path))
    resolved = resolve_safe_dir(tenant_id=1, raw="")
    assert resolved == (tmp_path / "1").resolve()


def test_path_resolver_traversal_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MAUGOOD_ERP_EXPORT_ROOT", str(tmp_path))
    with pytest.raises(UnsafeOutputPath):
        resolve_safe_dir(tenant_id=1, raw="../../etc")
    with pytest.raises(UnsafeOutputPath):
        resolve_safe_dir(tenant_id=1, raw="incoming/../../escape")


def test_path_resolver_absolute_outside_root_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MAUGOOD_ERP_EXPORT_ROOT", str(tmp_path))
    with pytest.raises(UnsafeOutputPath):
        resolve_safe_dir(tenant_id=1, raw="/tmp/elsewhere")


def test_path_resolver_absolute_inside_root_accepted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MAUGOOD_ERP_EXPORT_ROOT", str(tmp_path))
    target = tmp_path / "1" / "incoming"
    resolved = resolve_safe_dir(tenant_id=1, raw=str(target))
    assert resolved == target.resolve()


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def _row(**overrides) -> ExportRow:  # type: ignore[no-untyped-def]
    base = {
        "employee_code": "OM0042",
        "full_name": "Aisha Al-Hinai",
        "date": date(2026, 4, 25),
        "in_time": time(7, 28, 42),
        "out_time": time(15, 34, 12),
        "total_minutes": 486,
        "late": False,
        "early_out": False,
        "short_hours": False,
        "overtime_minutes": 6,
        "status": "on_time",
        "policy_code": "Fixed",
        "tenant_slug": "tenant_omran",
    }
    base.update(overrides)
    return ExportRow(**base)


def test_csv_columns_and_boolean_serialisation() -> None:
    rows = [
        _row(),
        _row(employee_code="OM0044", in_time=None, out_time=None,
             total_minutes=None, status="absent", overtime_minutes=0),
    ]
    body = render_csv(rows).decode("utf-8")
    lines = body.splitlines()
    assert lines[0] == ",".join(CSV_COLUMNS)
    assert "OM0042,Aisha Al-Hinai,2026-04-25,07:28:42,15:34:12,486,false,false,false,6,on_time,Fixed,tenant_omran" in lines[1]
    # Empty in/out + total_minutes for the absent row.
    assert "OM0044,Aisha Al-Hinai,2026-04-25,,,,false,false,false,0,absent,Fixed,tenant_omran" in lines[2]


def test_json_layout_carries_metadata_and_records() -> None:
    rows = [_row()]
    body = render_json(
        rows,
        metadata={
            "tenant_slug": "tenant_omran",
            "generated_at": "2026-04-25T08:00:00Z",
            "range_start": "2026-04-25",
            "range_end": "2026-04-25",
            "row_count": 1,
            "schema_version": 1,
        },
    )
    payload = json.loads(body)
    assert payload["metadata"]["schema_version"] == 1
    assert payload["metadata"]["row_count"] == 1
    assert payload["records"][0]["status"] == "on_time"
    assert payload["records"][0]["in_time"] == "07:28:42"


def test_filename_format() -> None:
    from datetime import datetime, timezone  # noqa: PLC0415

    fname = filename_for(
        fmt="csv", now=datetime(2026, 4, 25, 8, 30, 5, tzinfo=timezone.utc)
    )
    assert fname == "maugood-attendance-20260425-083005.csv"


# ---------------------------------------------------------------------------
# Config endpoints + run-now
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_erp_config(admin_engine, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Each P19 API test runs against a fresh tenant root + a default
    erp_export_config row. We point the tenant root at ``tmp_path``
    so the suite never writes into ``/data/erp``."""

    monkeypatch.setenv("MAUGOOD_ERP_EXPORT_ROOT", str(tmp_path))

    def _reset() -> None:
        with admin_engine.begin() as conn:
            conn.execute(
                update(erp_export_config)
                .where(erp_export_config.c.tenant_id == 1)
                .values(
                    enabled=False,
                    format="csv",
                    output_path="",
                    schedule_cron="",
                    window_days=1,
                    last_run_at=None,
                    last_run_status=None,
                    last_run_path=None,
                    last_run_error=None,
                    next_run_at=None,
                )
            )

    _reset()
    yield
    _reset()


def test_get_config_returns_tenant_root(
    client: TestClient, admin_user: dict, tmp_path: Path
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/erp-export-config")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tenant_id"] == 1
    assert body["tenant_root"].startswith(str(tmp_path))


def test_patch_config_rejects_traversal_path(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.patch(
        "/api/erp-export-config",
        json={"output_path": "../../escape"},
    )
    assert resp.status_code == 400
    assert "output_path" in resp.json()["detail"].lower() or "resolve" in resp.json()["detail"].lower()


def test_patch_config_rejects_invalid_cron(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.patch(
        "/api/erp-export-config",
        json={"schedule_cron": "not a cron"},
    )
    assert resp.status_code == 422


def test_employee_role_403_on_patch(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.patch("/api/erp-export-config", json={"enabled": True})
    assert resp.status_code == 403


def test_run_now_writes_csv_and_streams_bytes(
    client: TestClient,
    admin_user: dict,
    seeded_attendance,
    admin_engine,
    tmp_path: Path,
) -> None:
    _login(client, admin_user)
    client.patch(
        "/api/erp-export-config",
        json={
            "format": "csv",
            "output_path": "incoming",
            "window_days": 7,
            "enabled": True,
        },
    )
    resp = client.post("/api/erp-export-config/run-now", json={})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    cd = resp.headers["content-disposition"]
    assert "maugood-attendance-" in cd and cd.endswith('.csv"')

    body_text = resp.content.decode("utf-8")
    assert body_text.splitlines()[0] == ",".join(CSV_COLUMNS)
    # P13 seed creates two employees — both should appear.
    assert "P13-ENG" in body_text
    assert "P13-OPS" in body_text
    # tenant_slug is the schema name for tenant_id=1 (pilot uses 'main').
    assert "main" in body_text

    # File landed on disk under {tmp_path}/1/incoming/{filename}.csv
    drop_dir = tmp_path / "1" / "incoming"
    files = list(drop_dir.glob("maugood-attendance-*.csv"))
    assert len(files) == 1, files
    assert files[0].read_bytes() == resp.content

    # Config row updated with last_run_status=succeeded + path.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(
                erp_export_config.c.last_run_status,
                erp_export_config.c.last_run_path,
                erp_export_config.c.last_run_error,
            ).where(erp_export_config.c.tenant_id == 1)
        ).first()
    assert row.last_run_status == "succeeded"
    assert row.last_run_path == str(files[0])
    assert row.last_run_error is None

    # Audit row written.
    with admin_engine.begin() as conn:
        latest_audit = conn.execute(
            select(audit_log.c.action, audit_log.c.after).where(
                audit_log.c.tenant_id == 1,
                audit_log.c.entity_type == "erp_export_run",
            ).order_by(audit_log.c.id.desc()).limit(1)
        ).first()
    assert latest_audit.action == "erp_export.run_succeeded"
    assert latest_audit.after["filename"].endswith(".csv")
    assert latest_audit.after["row_count"] >= 2


def test_run_now_json_payload_has_metadata(
    client: TestClient,
    admin_user: dict,
    seeded_attendance,
    tmp_path: Path,
) -> None:
    _login(client, admin_user)
    client.patch(
        "/api/erp-export-config",
        json={"format": "json", "window_days": 7, "enabled": True},
    )
    resp = client.post("/api/erp-export-config/run-now", json={})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    payload = json.loads(resp.content.decode("utf-8"))
    assert payload["metadata"]["schema_version"] == 1
    assert payload["metadata"]["tenant_slug"] == "main"
    assert payload["metadata"]["row_count"] == len(payload["records"])
    assert payload["records"][0]["status"] in (
        "on_time",
        "late",
        "absent",
        "short",
        "early_out",
        "leave",
    )
