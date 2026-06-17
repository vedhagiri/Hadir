#!/usr/bin/env python3
"""Map employee "Reports To" from an Excel roster — standalone, no import.

Reads the roster, resolves each row's ``reports_to_email`` cell (a manager
EMAIL, full NAME, or employee_code) to the manager's EMPLOYEE that already
exists in the database, and writes ``employees.reports_to_employee_id``.
It also sets ``reports_to_user_id`` when the manager happens to have a real
login (matched by the manager's email) — never creating one.

It does NOT create employees, users, or dummy emails, and it does NOT touch
any other column. Matching is against employees ALREADY in the DB, so no
employee import is needed. Idempotent: re-running only fixes drift.

Self-contained: depends only on ``psycopg`` + ``openpyxl`` (both ship in
the backend image). Run it inside the backend container:

    docker compose cp employee_list_omran.xlsx backend:/tmp/roster.xlsx
    docker compose exec backend python scripts/map_reports_to_from_excel.py \
        /tmp/roster.xlsx --schema main --dry-run        # preview
    docker compose exec backend python scripts/map_reports_to_from_excel.py \
        /tmp/roster.xlsx --schema main                  # apply

The DB connection is read from ``MAUGOOD_ADMIN_DATABASE_URL`` (the owner
role, so it can ALTER TABLE) or ``--db-url``.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict

import psycopg
from openpyxl import load_workbook

_SCHEMA_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _norm(s: object) -> str:
    return re.sub(r"\s+", " ", str(s)).strip().lower() if s else ""


def _pg_url(raw: str) -> str:
    # SQLAlchemy-style "postgresql+psycopg://" → libpq "postgresql://".
    return raw.replace("postgresql+psycopg://", "postgresql://").replace(
        "postgresql+psycopg2://", "postgresql://"
    )


def _read_roster(path: str) -> list[dict]:
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise SystemExit("roster is empty")
    hdr = [
        (str(c).strip().lower().replace(" ", "_") if c else "") for c in rows[0]
    ]
    alias = {"department": "department_code", "reports_to": "reports_to_email"}
    hdr = [alias.get(h, h) for h in hdr]

    def idx(name: str):
        return hdr.index(name) if name in hdr else None

    ic, inm, irt = idx("employee_code"), idx("full_name"), idx("reports_to_email")
    if ic is None or irt is None:
        raise SystemExit(
            "roster must have 'employee_code' and 'reports_to_email' columns"
        )
    out = []
    for r in rows[1:]:
        code = str(r[ic]).strip() if r[ic] else ""
        name = str(r[inm]).strip() if inm is not None and r[inm] else ""
        rt = str(r[irt]).strip() if r[irt] else ""
        if not code and not name:
            continue
        out.append({"code": code, "name": name, "rt": rt})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", help="Path to the roster .xlsx")
    ap.add_argument("--schema", default="main", help="Tenant schema (default: main)")
    ap.add_argument("--db-url", default=os.environ.get("MAUGOOD_ADMIN_DATABASE_URL"))
    ap.add_argument("--dry-run", action="store_true", help="Preview, write nothing")
    args = ap.parse_args()

    if not args.db_url:
        raise SystemExit("no DB URL — set MAUGOOD_ADMIN_DATABASE_URL or pass --db-url")
    if not _SCHEMA_RE.match(args.schema):
        raise SystemExit(f"invalid schema name: {args.schema!r}")
    schema = args.schema

    roster = _read_roster(args.file)

    with psycopg.connect(_pg_url(args.db_url), autocommit=False) as conn:
        cur = conn.cursor()
        cur.execute(f'SET search_path TO "{schema}", public')

        # tenant_id for this schema (employees.tenant_id is NOT NULL).
        cur.execute("SELECT id FROM public.tenants WHERE schema_name = %s", (schema,))
        row = cur.fetchone()
        if row is None:
            raise SystemExit(f"no tenant with schema_name={schema!r} in public.tenants")
        tenant_id = int(row[0])

        # 1. Ensure the org-chart column exists (idempotent — works on the
        #    old schema that predates it). Non-destructive.
        cur.execute(
            """SELECT 1 FROM information_schema.columns
               WHERE table_schema = %s AND table_name = 'employees'
                 AND column_name = 'reports_to_employee_id'""",
            (schema,),
        )
        col_exists = cur.fetchone() is not None
        if not col_exists:
            print(f"[schema] adding {schema}.employees.reports_to_employee_id")
            if not args.dry_run:
                cur.execute(
                    f'ALTER TABLE "{schema}".employees '
                    f"ADD COLUMN reports_to_employee_id INTEGER "
                    f'REFERENCES "{schema}".employees(id) ON DELETE SET NULL'
                )
                cur.execute(
                    f'CREATE INDEX IF NOT EXISTS ix_employees_reports_to_employee '
                    f'ON "{schema}".employees (tenant_id, reports_to_employee_id)'
                )
                col_exists = True

        # 2. Load every employee in the schema → resolution indexes.
        #    The column may still be absent in a dry-run on the old schema,
        #    so select a literal NULL for it in that case.
        rt_col = "reports_to_employee_id" if col_exists else "NULL AS reports_to_employee_id"
        cur.execute(
            f"SELECT id, employee_code, full_name, email, {rt_col}, reports_to_user_id "
            "FROM employees WHERE tenant_id = %s",
            (tenant_id,),
        )
        by_code: dict[str, int] = {}
        by_email: dict[str, int] = {}
        by_name: dict[str, list[int]] = defaultdict(list)
        emp_email_by_id: dict[int, str] = {}
        current: dict[int, tuple] = {}
        for eid, code, name, email, rt_emp, rt_user in cur.fetchall():
            if code:
                by_code[code.strip().lower()] = eid
            if email and str(email).strip():
                by_email[str(email).strip().lower()] = eid
                emp_email_by_id[eid] = str(email).strip().lower()
            if name:
                by_name[_norm(name)].append(eid)
            current[eid] = (rt_emp, rt_user)

        # users → so we can ALSO set reports_to_user_id (the link the
        # pre-update Team Members screen reads). Indexed by email AND by
        # name, so a manager with a real login (even when their employee
        # record has no email) is matched. Never creates a user.
        cur.execute("SELECT id, email, full_name FROM users WHERE tenant_id = %s", (tenant_id,))
        user_by_email: dict[str, int] = {}
        user_by_name: dict[str, list[int]] = defaultdict(list)
        for uid, e, nm in cur.fetchall():
            if e and str(e).strip():
                user_by_email[str(e).strip().lower()] = uid
            if nm and str(nm).strip():
                user_by_name[_norm(nm)].append(uid)

        def resolve(value: str):
            """→ (manager_employee_id | None, ambiguous: bool)."""
            v = value.strip()
            low = v.lower()
            if low in by_email:
                return by_email[low], False
            n = _norm(v)
            if n in by_name:
                ids = by_name[n]
                return (ids[0], False) if len(ids) == 1 else (None, True)
            if low in by_code:
                return by_code[low], False
            return None, False

        def resolve_user(value: str, mgr_emp_id):
            """→ manager_user_id | None (existing login only, never created)."""
            low = value.strip().lower()
            if low in user_by_email:
                return user_by_email[low]
            n = _norm(value)
            if n in user_by_name and len(user_by_name[n]) == 1:
                return user_by_name[n][0]
            em = emp_email_by_id.get(mgr_emp_id) if mgr_emp_id else None
            if em and em in user_by_email:
                return user_by_email[em]
            return None

        set_n = already = no_rt = emp_missing = unknown = ambiguous = self_ref = 0
        user_linked = 0
        not_found: dict[str, list[str]] = defaultdict(list)

        for row in roster:
            if not row["rt"]:
                no_rt += 1
                continue
            emp_id = by_code.get(row["code"].strip().lower())
            if emp_id is None:
                emp_missing += 1
                continue
            mgr_id, amb = resolve(row["rt"])
            if amb:
                ambiguous += 1
                print(f"  [ambiguous] {row['code']}: manager '{row['rt']}' matches >1 employee")
                continue
            if mgr_id is None:
                unknown += 1
                not_found[row["rt"]].append(row["code"])
                continue
            if mgr_id == emp_id:
                self_ref += 1
                continue
            mgr_user_id = resolve_user(row["rt"], mgr_id)
            cur_emp, cur_user = current.get(emp_id, (None, None))
            # Already correct only when BOTH links match what we'd write.
            if cur_emp == mgr_id and (mgr_user_id is None or cur_user == mgr_user_id):
                already += 1
                continue
            set_n += 1
            if mgr_user_id is not None:
                user_linked += 1
            if not args.dry_run:
                if mgr_user_id is not None:
                    cur.execute(
                        "UPDATE employees SET reports_to_employee_id = %s, "
                        "reports_to_user_id = %s WHERE id = %s AND tenant_id = %s",
                        (mgr_id, mgr_user_id, emp_id, tenant_id),
                    )
                else:
                    cur.execute(
                        "UPDATE employees SET reports_to_employee_id = %s "
                        "WHERE id = %s AND tenant_id = %s",
                        (mgr_id, emp_id, tenant_id),
                    )

        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()

        print("\n── reports-to mapping summary ──")
        print(f"  schema:               {schema} (tenant_id={tenant_id})")
        print(f"  roster rows:          {len(roster)}")
        print(f"  {'would map' if args.dry_run else 'mapped'}:             {set_n}")
        print(f"    of which user-linked (shows on old UI): {user_linked}")
        print(f"  already correct:      {already}")
        print(f"  no reports-to cell:   {no_rt}")
        print(f"  employee not in DB:   {emp_missing}")
        print(f"  ambiguous manager:    {ambiguous}")
        print(f"  self-reference:       {self_ref}")
        print(f"  MANAGER NOT FOUND:    {unknown} rows / {len(not_found)} names")
        for name in sorted(not_found, key=lambda k: (-len(not_found[k]), k)):
            print(f"      - {name}  ({len(not_found[name])}): {', '.join(not_found[name])}")
        if args.dry_run:
            print("\n  (dry run — nothing written)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
