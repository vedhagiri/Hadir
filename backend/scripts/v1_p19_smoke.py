"""End-to-end smoke for v1.0 P19 — ERP file-drop export.

Mirrors the prompt's verification scenario: configure the ERP
export for the ``main`` (Omran) tenant, hit Run-now, confirm the
file landed in the expected directory under the tenant root with
the spec'd schema, and verify the run-now response streams the same
bytes back.

Run inside the backend container:

    docker compose exec -e MAUGOOD_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p19_smoke
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, time
from pathlib import Path

import httpx
from sqlalchemy import delete, insert, select, update

from maugood.db import (
    attendance_records,
    audit_log,
    employees,
    erp_export_config,
    make_admin_engine,
    shift_policies,
)
from maugood.erp_export.builder import CSV_COLUMNS


BASE = "http://localhost:8000"
TENANT_ID = 1


def _seed_attendance(admin_engine) -> tuple[int, int]:
    today = date.today()
    with admin_engine.begin() as conn:
        for code in ("P19-A", "P19-B"):
            existing = conn.execute(
                select(employees.c.id).where(
                    employees.c.tenant_id == TENANT_ID,
                    employees.c.employee_code == code,
                )
            ).first()
            if existing is not None:
                conn.execute(
                    delete(attendance_records).where(
                        attendance_records.c.employee_id == int(existing.id)
                    )
                )
                conn.execute(
                    delete(employees).where(
                        employees.c.id == int(existing.id)
                    )
                )
        a = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P19-A",
                    full_name="P19 Smoke Alice",
                    email="alice@p19.maugood",
                    department_id=1,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        b = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code="P19-B",
                    full_name="P19 Smoke Bob",
                    email="bob@p19.maugood",
                    department_id=2,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
        policy_id = int(
            conn.execute(
                select(shift_policies.c.id)
                .where(shift_policies.c.tenant_id == TENANT_ID)
                .order_by(shift_policies.c.id.asc())
                .limit(1)
            ).scalar_one()
        )
        for emp_id, the_date, in_t, out_t, late, ot in (
            (a, today, time(7, 28), time(15, 36), False, 8),
            (b, today, time(7, 50), time(15, 5), True, 0),
        ):
            total = (out_t.hour * 60 + out_t.minute) - (
                in_t.hour * 60 + in_t.minute
            )
            conn.execute(
                insert(attendance_records).values(
                    tenant_id=TENANT_ID,
                    employee_id=emp_id,
                    date=the_date,
                    in_time=in_t,
                    out_time=out_t,
                    total_minutes=total,
                    policy_id=policy_id,
                    late=late,
                    early_out=False,
                    short_hours=total < 480,
                    absent=False,
                    overtime_minutes=ot,
                )
            )
    return a, b


def _cleanup(admin_engine, a: int, b: int) -> None:
    with admin_engine.begin() as conn:
        conn.execute(
            update(erp_export_config)
            .where(erp_export_config.c.tenant_id == TENANT_ID)
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
        conn.execute(
            delete(attendance_records).where(
                attendance_records.c.employee_id.in_([a, b])
            )
        )
        conn.execute(
            delete(employees).where(employees.c.id.in_([a, b]))
        )
        conn.execute(
            delete(audit_log).where(
                audit_log.c.entity_type == "erp_export_run"
            )
        )


def main() -> int:
    if not os.environ.get("MAUGOOD_SMOKE_PASSWORD"):
        print("[p19] set MAUGOOD_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    # The smoke runs against the live uvicorn process, which uses
    # the default ``MAUGOOD_ERP_EXPORT_ROOT`` (``/data/erp``) — setting
    # the env in this process wouldn't reach it. We just read the
    # tenant_root the API reports back and cleanup that subtree.
    admin_engine = make_admin_engine()
    a, b = _seed_attendance(admin_engine)

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            login = c.post(
                "/api/auth/login",
                json={
                    "email": "admin@pilot.maugood",
                    "password": os.environ["MAUGOOD_SMOKE_PASSWORD"],
                },
            )
            login.raise_for_status()
            print("[p19] login OK")

            # 1) Reject a traversal path explicitly.
            bad = c.patch(
                "/api/erp-export-config",
                json={"output_path": "../../escape"},
            )
            assert bad.status_code == 400, bad.text
            print(
                f"[p19] traversal path rejected: {bad.status_code} {bad.json()['detail']!r}"
            )

            # 2) Configure CSV export.
            cfg = c.patch(
                "/api/erp-export-config",
                json={
                    "format": "csv",
                    "output_path": "incoming/attendance",
                    "window_days": 7,
                    "schedule_cron": "0 1 * * *",
                    "enabled": True,
                },
            )
            cfg.raise_for_status()
            print(
                f"[p19] config saved: format={cfg.json()['format']} "
                f"output_path={cfg.json()['output_path']!r} "
                f"tenant_root={cfg.json()['tenant_root']}"
            )

            # 3) Run now (CSV). Clear any leftover files from a prior
            # failed smoke first so the "exactly one file" assertion
            # is deterministic.
            tenant_root = Path(cfg.json()["tenant_root"])
            drop_dir = tenant_root / "incoming" / "attendance"
            if drop_dir.is_dir():
                for f in drop_dir.glob("maugood-attendance-*"):
                    try:
                        f.unlink()
                    except OSError:
                        pass

            run = c.post("/api/erp-export-config/run-now", json={})
            run.raise_for_status()
            assert run.headers["content-type"].startswith("text/csv")
            csv_text = run.content.decode("utf-8")
            header = csv_text.splitlines()[0]
            assert header == ",".join(CSV_COLUMNS), header
            print(
                f"[p19] CSV run-now: {len(run.content)}B header_OK "
                f"rows={len(csv_text.splitlines()) - 1}"
            )

            # The runner says it sent the bytes back; confirm a real
            # file landed under the tenant root with the same bytes.
            files = list(drop_dir.glob("maugood-attendance-*.csv"))
            assert len(files) == 1, files
            on_disk = files[0].read_bytes()
            assert on_disk == run.content
            print(
                f"[p19] CSV file on disk: {files[0]} "
                f"({files[0].stat().st_size}B)"
            )

            # Both seeded employees + the tenant slug 'main' show up
            # in the body — same shape clients ERP teams will read.
            assert "P19-A" in csv_text and "P19-B" in csv_text
            assert ",main" in csv_text  # tenant_slug column
            print("[p19] CSV contents include both seeded employees")

            # 4) Switch to JSON and re-run.
            c.patch(
                "/api/erp-export-config",
                json={"format": "json"},
            ).raise_for_status()
            run_json = c.post("/api/erp-export-config/run-now", json={})
            run_json.raise_for_status()
            assert run_json.headers["content-type"].startswith("application/json")
            payload = json.loads(run_json.content.decode("utf-8"))
            assert payload["metadata"]["schema_version"] == 1
            assert payload["metadata"]["tenant_slug"] == "main"
            assert payload["metadata"]["row_count"] == len(payload["records"])
            print(
                f"[p19] JSON run-now: {len(run_json.content)}B "
                f"row_count={payload['metadata']['row_count']} "
                f"range={payload['metadata']['range_start']} → "
                f"{payload['metadata']['range_end']}"
            )

            # 5) Audit row landed for the JSON run.
            with admin_engine.begin() as conn:
                audit_row = conn.execute(
                    select(
                        audit_log.c.action,
                        audit_log.c.after,
                    ).where(
                        audit_log.c.tenant_id == TENANT_ID,
                        audit_log.c.entity_type == "erp_export_run",
                    ).order_by(audit_log.c.id.desc()).limit(1)
                ).first()
            assert audit_row.action == "erp_export.run_succeeded"
            assert audit_row.after["filename"].endswith(".json")
            print(
                f"[p19] audit row: action={audit_row.action} "
                f"filename={audit_row.after['filename']!r}"
            )

        print("[p19] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p19] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        _cleanup(admin_engine, a, b)
        admin_engine.dispose()
        # Best-effort cleanup of the file-drop subtree we wrote into.
        try:
            import shutil  # noqa: PLC0415
            from maugood.config import get_settings  # noqa: PLC0415

            root = Path(get_settings().erp_export_root) / str(TENANT_ID)
            shutil.rmtree(root, ignore_errors=True)
        except OSError:
            pass
        print("[p19] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
