"""One-off backfill: rebuild the employee→employee org chart from a roster.

Use this when employees already exist and you do NOT want to re-import
them. It reads the same Excel roster, and for each row resolves the
``reports_to_email`` cell (an email OR a manager name OR an
employee_code) to the manager's **employee** record, then sets
``employees.reports_to_employee_id`` on the existing employee matched by
``employee_code``.

It NEVER creates employees or users, never touches emails, names,
departments, or any other column — only ``reports_to_employee_id``.
Idempotent: re-running is a no-op once links are correct.

Run it (after deploying the build that adds migration 0084):

    # copy the roster into the container first, e.g.
    #   docker compose cp employee_list_omran.xlsx backend:/tmp/roster.xlsx
    docker compose exec backend python -m scripts.backfill_reports_to \
        --file /tmp/roster.xlsx --schema main

``--schema`` is the tenant's Postgres schema (``main`` for the pilot /
Omran). Pass ``--dry-run`` to see what it WOULD change without writing.
"""

from __future__ import annotations

import argparse
import sys
from io import BytesIO

from sqlalchemy import select, update

from maugood.db import (
    employees as employees_tbl,
    make_admin_engine,
    tenant_context,
    tenants as tenants_tbl,
)
from maugood.employees import excel as excel_io
from maugood.employees import repository as repo
from maugood.tenants.scope import TenantScope


def _resolve_tenant_id(engine, schema: str) -> int:
    """Read the tenant_id for a schema from public.tenants."""
    with tenant_context("public"):
        with engine.begin() as conn:
            row = conn.execute(
                select(tenants_tbl.c.id).where(
                    tenants_tbl.c.schema_name == schema
                )
            ).first()
    if row is None:
        raise SystemExit(
            f"no tenant in public.tenants has schema_name='{schema}'"
        )
    return int(row.id)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", required=True, help="Path to the roster .xlsx")
    ap.add_argument(
        "--schema", default="main", help="Tenant schema (default: main)"
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing",
    )
    args = ap.parse_args()

    try:
        with open(args.file, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise SystemExit(f"could not read {args.file}: {exc}")

    rows = list(excel_io.parse_import(BytesIO(data)))
    engine = make_admin_engine()
    tenant_id = _resolve_tenant_id(engine, args.schema)
    scope = TenantScope(tenant_id=tenant_id)

    set_count = 0
    already = 0
    no_reports_to = 0
    emp_missing = 0
    unknown_mgr = 0
    ambiguous = 0
    self_ref = 0

    with tenant_context(args.schema):
        for row in rows:
            rt = (row.reports_to_email or "").strip() if row.reports_to_email else ""
            if not rt:
                no_reports_to += 1
                continue
            with engine.begin() as conn:
                emp = repo.get_employee_by_code(conn, scope, row.employee_code)
                if emp is None:
                    emp_missing += 1
                    print(f"  [skip] no employee for code {row.employee_code!r}")
                    continue
                try:
                    mgr_id, mgr_user_id = repo.resolve_manager_links(
                        conn, scope, rt
                    )
                except ValueError as exc:
                    ambiguous += 1
                    print(f"  [ambiguous] {row.employee_code}: {exc}")
                    continue
                if mgr_id is None:
                    unknown_mgr += 1
                    print(
                        f"  [unknown manager] {row.employee_code} "
                        f"-> {rt!r} (left unset)"
                    )
                    continue
                if mgr_id == emp.id:
                    self_ref += 1
                    print(f"  [self] {row.employee_code} reports to itself (skipped)")
                    continue
                if emp.reports_to_employee_id == mgr_id and (
                    mgr_user_id is None or emp.reports_to_user_id == mgr_user_id
                ):
                    already += 1
                    continue
                if args.dry_run:
                    print(
                        f"  [would set] {row.employee_code} "
                        f"reports_to_employee_id={mgr_id}"
                        + (
                            f" reports_to_user_id={mgr_user_id}"
                            if mgr_user_id is not None
                            else ""
                        )
                        + f" ({rt})"
                    )
                    set_count += 1
                    continue
                # employee link always; user link only when a real login
                # exists (never create one).
                vals: dict[str, object] = {"reports_to_employee_id": mgr_id}
                if mgr_user_id is not None:
                    vals["reports_to_user_id"] = mgr_user_id
                conn.execute(
                    update(employees_tbl)
                    .where(
                        employees_tbl.c.tenant_id == scope.tenant_id,
                        employees_tbl.c.id == emp.id,
                    )
                    .values(**vals)
                )
                set_count += 1

    print("\n── backfill summary ──")
    print(f"  schema:                {args.schema} (tenant_id={tenant_id})")
    print(f"  rows in file:          {len(rows)}")
    print(f"  links {'would be ' if args.dry_run else ''}set:           {set_count}")
    print(f"  already correct:       {already}")
    print(f"  no reports-to cell:    {no_reports_to}")
    print(f"  employee not found:    {emp_missing}")
    print(f"  manager not found:     {unknown_mgr}")
    print(f"  ambiguous manager:     {ambiguous}")
    print(f"  self-reference:        {self_ref}")
    if args.dry_run:
        print("\n  (dry run — nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
