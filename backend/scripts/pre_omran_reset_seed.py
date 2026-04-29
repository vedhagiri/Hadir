"""Pre-Omran reset + seed.

A single re-runnable script that wipes the local Maugood database,
re-provisions every tenant the validation walkthrough touches,
seeds rich dummy data, and writes a fresh ``credentials.txt`` at
the repo root.

After this runs, Suresh follows
``docs/testing/pre-omran-validation.md`` to walk every v1.0
feature end-to-end with both the synthetic ``tenant_mts_demo``
data and a real corporate tenant Suresh named at the top of
this file.
"""

from __future__ import annotations

# ╔══════════════════════════════════════════════════════════════════╗
# ║                                                                  ║
# ║  EDIT THESE THREE CONSTANTS BEFORE RUNNING.                      ║
# ║                                                                  ║
# ║  The script refuses to run if any still contains a placeholder   ║
# ║  string (``__…__``). Reset to placeholders after a run so the    ║
# ║  next operator has to set them deliberately.                     ║
# ║                                                                  ║
# ╚══════════════════════════════════════════════════════════════════╝

REAL_CORPORATE_NAME = "Inaisys Solutions"  # e.g. "MTS Office"
REAL_CORPORATE_SLUG = "inaisys"  # e.g. "mts-office" (lowercase, hyphens)
REAL_TEST_EMPLOYEE_NAME = "Giri"  # the real human whose face will be enrolled
# Optional: override the corporate email domain. Default derives from the slug.
REAL_CORPORATE_DOMAIN: "str | None" = "inaisys.local"  # e.g. "mts.local" — None auto-derives


# ────────────────────────────────────────────────────────────────────
# Everything below is the script. No edits expected here.
# ────────────────────────────────────────────────────────────────────

import argparse
import logging
import os
import re
import secrets
import string
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import insert, select, text
from sqlalchemy.engine import Connection, Engine

from maugood.db import (
    cameras,
    custom_fields,
    holidays,
    leave_types,
    make_admin_engine,
    mts_staff,
    policy_assignments,
    reset_tenant_schema,
    set_tenant_schema,
    shift_policies,
    tenants,
)

# Internal helpers from this directory.
sys.path.insert(0, str(Path(__file__).parent / "_seed_data"))
from wordlist import WORDS  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from _seed_helpers import (  # noqa: E402
    SYSTEM_SEED_LABEL,
    assign_manager,
    create_employee,
    create_user,
    department_ids_by_code,
    ensure_department,
    hash_pw,
    role_ids_by_code,
    write_seed_audit,
)
from provision_tenant import provision_tenant  # noqa: E402

logger = logging.getLogger("maugood.pre_omran_reset_seed")


# ────────────────────────────────────────────────────────────────────
# Constants — driving the seed shape
# ────────────────────────────────────────────────────────────────────

DEMO_SLUG = "mts_demo"
DEMO_NAME = "MTS Demo Co"
DEMO_DOMAIN = "mts-demo.example.com"
DEMO_BRANDING = {"primary_color_key": "plum", "font_key": "plus-jakarta-sans"}

# Internal Postgres schema name the demo tenant lives in. Derived
# from the friendly slug via ``schema_name_for_slug``; never typed
# by an operator and never accepted as login input. We hold it as a
# constant here only because seed code calls ``tenant_context(...)``
# directly (which takes a schema, not a slug) — every other surface
# routes through the friendly slug.
def _demo_schema() -> str:
    from maugood.tenants.slug import schema_name_for_slug  # noqa: PLC0415

    return schema_name_for_slug(DEMO_SLUG)

# Real-corporate branding — distinctly different from demo so the two
# are immediately visually distinguishable in side-by-side windows.
REAL_BRANDING = {"primary_color_key": "navy", "font_key": "inter"}

# Demo tenant — 5 departments to exercise multi-department managers.
DEMO_DEPARTMENTS: tuple[tuple[str, str], ...] = (
    ("ENG", "Engineering"),
    ("OPS", "Operations"),
    ("SAL", "Sales"),
    ("FIN", "Finance"),
    ("ADM", "Administration"),
)

# Real corporate — keep it simple. Two departments to start; the
# operator extends through the UI as the team grows.
REAL_DEPARTMENTS: tuple[tuple[str, str], ...] = (
    ("OFC", "Office"),
    ("OPS", "Operations"),
)

# Oman 2026 holidays. Hijri-derived dates are approximations — Omran
# HR confirms exact dates per year. Kept here as a deliberate
# "good-enough for validation" set; the real production calendar
# lands at P29 cutover with HR's authoritative dates.
DEMO_HOLIDAYS_2026: tuple[tuple[str, str], ...] = (
    ("2026-01-01", "New Year's Day"),
    ("2026-02-26", "Islamic New Year (approx)"),
    ("2026-05-07", "Prophet's Birthday (approx)"),
    ("2026-07-23", "Renaissance Day"),
    ("2026-04-09", "Eid Al-Fitr — Day 1 (approx)"),
    ("2026-04-10", "Eid Al-Fitr — Day 2 (approx)"),
    ("2026-04-11", "Eid Al-Fitr — Day 3 (approx)"),
    ("2026-06-16", "Eid Al-Adha — Day 1 (approx)"),
    ("2026-06-17", "Eid Al-Adha — Day 2 (approx)"),
    ("2026-06-18", "Eid Al-Adha — Day 3 (approx)"),
    ("2026-06-19", "Eid Al-Adha — Day 4 (approx)"),
    ("2026-11-18", "National Day"),
)

# Leave types beyond the four the provisioning CLI seeds.
DEMO_EXTRA_LEAVE_TYPES: tuple[tuple[str, str, bool], ...] = (
    ("Maternity", "Maternity leave", True),
    ("Paternity", "Paternity leave", True),
    ("Bereavement", "Bereavement leave", True),
)

# 30 plausibly-Omani names (mix of Arabic + Western for an
# inclusive demo population). Fictional — no real person referenced.
DEMO_NAMES: tuple[str, ...] = (
    "Aisha Al-Hinai", "Khalid Al-Saadi", "Salma Al-Maamari", "Nasser Al-Balushi",
    "Maryam Al-Riyami", "Sultan Al-Habsi", "Fatma Al-Lawati", "Hassan Al-Wahaibi",
    "Dawud Al-Farsi", "Layla Al-Mahrouqi", "Faisal Al-Shukaili", "Noor Al-Busaidi",
    "Yusuf Al-Kindi", "Hala Al-Mughairy", "Tariq Al-Zadjali", "Reem Al-Kalbani",
    "Rashid Al-Harthy", "Shaikha Al-Maskari", "Zayd Al-Mahri", "Asma Al-Lamki",
    "Omar Al-Bahri", "Houda Al-Siyabi", "Bilal Al-Battashi", "Nada Al-Wahaibi",
    "Said Al-Rawahi", "Iman Al-Adawi", "Mohammed Al-Hashmi", "Latifa Al-Tobi",
    "Adam Mendez", "Eva Petrov",
)


@dataclass
class SeededUser:
    role_label: str
    email: str
    password: str
    note: str = ""


@dataclass
class TenantCredentials:
    slug: str
    display_name: str
    users: list[SeededUser] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


# ────────────────────────────────────────────────────────────────────
# Safety gates — the three-brake safety harness from the prompt
# ────────────────────────────────────────────────────────────────────

PLACEHOLDER_PATTERN = re.compile(r"__[A-Z_]+_HERE__")


def _placeholder_check() -> None:
    bad = []
    for label, value in (
        ("REAL_CORPORATE_NAME", REAL_CORPORATE_NAME),
        ("REAL_CORPORATE_SLUG", REAL_CORPORATE_SLUG),
        ("REAL_TEST_EMPLOYEE_NAME", REAL_TEST_EMPLOYEE_NAME),
    ):
        if PLACEHOLDER_PATTERN.fullmatch(value):
            bad.append(label)
    if bad:
        msg = (
            "Set REAL_CORPORATE_NAME and REAL_CORPORATE_SLUG at the top "
            "of the script before running."
        )
        # The prompt requires this exact phrasing.
        print(f"\n  ERROR: {msg}\n", file=sys.stderr)
        print(f"    Still placeholder: {', '.join(bad)}", file=sys.stderr)
        sys.exit(2)


def _slug_check(slug: str) -> None:
    # Mirrors ``maugood.tenants.slug.SLUG_RE`` — the same CHECK
    # migration 0026 enforces on ``public.tenants.slug``.
    from maugood.tenants.slug import SLUG_RE  # noqa: PLC0415

    if not SLUG_RE.match(slug):
        print(
            f"\n  ERROR: REAL_CORPORATE_SLUG must match {SLUG_RE.pattern} "
            "(lowercase a-z + digits + hyphens + underscores; start "
            "with a letter; 2-40 chars; e.g. 'mts-office').\n",
            file=sys.stderr,
        )
        sys.exit(2)


def _env_check() -> None:
    env = os.environ.get("MAUGOOD_ENV", "")
    if env != "dev":
        print(
            f"\n  ERROR: MAUGOOD_ENV must equal 'dev' (got {env!r}).\n"
            "  This script wipes data — refusing to run outside dev.\n",
            file=sys.stderr,
        )
        sys.exit(2)


def _typed_confirm() -> None:
    print("\n" + "─" * 64)
    print("This script wipes ALL Maugood data in the local database.")
    print("Type 'RESET' to continue (anything else aborts):")
    print("─" * 64)
    if not sys.stdin.isatty():
        # No tty — accept env-based confirmation for CI/test runs.
        if os.environ.get("MAUGOOD_RESET_CONFIRM") == "RESET":
            print("[non-tty] MAUGOOD_RESET_CONFIRM=RESET — proceeding")
            return
        print(
            "  ERROR: no TTY and MAUGOOD_RESET_CONFIRM is not set to RESET.",
            file=sys.stderr,
        )
        sys.exit(2)
    answer = input("  > ").strip()
    if answer != "RESET":
        print("Aborted (typed confirmation did not match).", file=sys.stderr)
        sys.exit(2)


def _employee_count_check(engine: Engine) -> None:
    """If any tenant has > 50 employees, refuse — that's a production-
    shaped database and the operator may have plugged the wrong host."""

    with engine.begin() as conn:
        # ``public.tenants`` may not exist on a freshly-init'd cluster
        # before any provisioning. Guard so the script can run on a
        # truly empty DB too.
        exists = conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name='tenants'"
            )
        ).scalar()
        if not exists:
            return
        rows = conn.execute(
            select(tenants.c.id, tenants.c.schema_name)
        ).all()
    too_big = []
    for row in rows:
        try:
            with engine.begin() as conn:
                count = conn.execute(
                    text(
                        f'SELECT count(*) FROM "{row.schema_name}".employees'
                    )
                ).scalar() or 0
            if int(count) > 50:
                too_big.append((row.schema_name, int(count)))
        except Exception:  # noqa: BLE001
            # Schema in registry but tables missing — treat as empty.
            continue
    if too_big:
        print(
            "\n  ERROR: production heuristic tripped — refusing to wipe.",
            file=sys.stderr,
        )
        for slug, count in too_big:
            print(f"    {slug}: {count} employees", file=sys.stderr)
        print(
            "  This script is a dev-only reset. If you really meant to do "
            "this on this DB, drop the schemas manually.",
            file=sys.stderr,
        )
        sys.exit(2)


# ────────────────────────────────────────────────────────────────────
# Wipe
# ────────────────────────────────────────────────────────────────────


def _wipe_database(engine: Engine) -> None:
    print("\n▸ Wiping database...")
    # Find every tenant_* schema + the legacy main; drop them; then
    # drop and recreate public.
    with engine.begin() as conn:
        rows = conn.execute(
            text(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name LIKE 'tenant_%' OR schema_name = 'main'"
            )
        ).all()
        for row in rows:
            schema = row.schema_name
            print(f"  drop schema {schema} cascade")
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        # public — drop and recreate so the global tenants registry
        # comes back from the migration head fresh.
        print("  drop schema public cascade + recreate")
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
        # The two roles persist across drops — they're cluster-level.
        conn.execute(text("GRANT USAGE ON SCHEMA public TO maugood_app"))
        conn.execute(text("GRANT USAGE ON SCHEMA public TO maugood_admin"))


def _migrate_public(backend_dir: Path) -> None:
    print("\n▸ Re-running migrations on public...")
    cmd = ["alembic", "-x", "schema=main", "upgrade", "head"]
    completed = subprocess.run(cmd, cwd=backend_dir, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"alembic upgrade failed for public/main (exit={completed.returncode})"
        )


# ────────────────────────────────────────────────────────────────────
# Password generation
# ────────────────────────────────────────────────────────────────────


def gen_password() -> str:
    """Three random words + 2-digit suffix + punctuation.

    ``secrets`` (CSPRNG) — never ``random``. Punctuation drawn from
    ``!#`` only (avoids ``$%&`` which interact badly with shell
    interpolation in case someone copies into ``.env``).
    """

    pieces = [secrets.choice(WORDS) for _ in range(3)]
    suffix = "".join(secrets.choice(string.digits) for _ in range(2))
    punct = secrets.choice("!#")
    return f"{'-'.join(pieces)}-{suffix}{punct}"


# ────────────────────────────────────────────────────────────────────
# Super-admin seed
# ────────────────────────────────────────────────────────────────────


def _seed_super_admins(engine: Engine) -> list[SeededUser]:
    print("\n▸ Seeding Super-Admin staff (public.mts_staff)...")
    out: list[SeededUser] = []
    token = set_tenant_schema("public")
    try:
        with engine.begin() as conn:
            for email, label in (
                # ``.test`` is reserved by RFC-2606 and rejected by
                # the email-validator's strict mode (same gap that
                # P28 caught for ``.local``). ``.example.com`` is the
                # other RFC-2606-reserved domain that the validator
                # accepts. Use it everywhere the seed touches an
                # email field that flows through the login API.
                ("superadmin@mts-staff.example.com", "Primary"),
                ("support@mts-staff.example.com", "Secondary (dual-actor test)"),
            ):
                pw = gen_password()
                conn.execute(
                    insert(mts_staff).values(
                        email=email,
                        password_hash=hash_pw(pw),
                        full_name=f"MTS {label}",
                        is_active=True,
                    )
                )
                out.append(SeededUser(role_label="Super-Admin", email=email, password=pw))
                print(f"  + {email}")
    finally:
        reset_tenant_schema(token)
    return out


# ────────────────────────────────────────────────────────────────────
# Demo tenant seed
# ────────────────────────────────────────────────────────────────────


def _set_branding(
    conn: Connection, *, tenant_id: int, branding: dict[str, str]
) -> None:
    """Update the (provision-seeded) tenant_branding row in place.

    Driven via raw SQL with explicit bind names so ``text(...)``
    doesn't accidentally interpret a key in the dict as a regex
    placeholder. (Caught on the first end-to-end run.)
    """

    conn.execute(
        text(
            "UPDATE tenant_branding SET primary_color_key = :color, "
            "font_key = :font WHERE tenant_id = :tid"
        ),
        {
            "color": branding["primary_color_key"],
            "font": branding["font_key"],
            "tid": tenant_id,
        },
    )


def _seed_demo_tenant(engine: Engine, *, tenant_id: int) -> TenantCredentials:
    demo_schema = _demo_schema()
    print(
        f"\n▸ Provisioning slug={DEMO_SLUG!r} schema={demo_schema!r} "
        f"(tenant_id={tenant_id})..."
    )
    creds = TenantCredentials(slug=DEMO_SLUG, display_name=DEMO_NAME)

    from maugood.db import tenant_context  # noqa: PLC0415

    with tenant_context(demo_schema):
        # All seed work in one transaction.
        with engine.begin() as conn:
            print("  · departments (5)")
            for code, name in DEMO_DEPARTMENTS:
                ensure_department(
                    conn, tenant_id=tenant_id, code=code, name=name
                )

            print("  · branding (plum + plus-jakarta-sans)")
            _set_branding(conn, tenant_id=tenant_id, branding=DEMO_BRANDING)

            print("  · holidays (Oman 2026)")
            for date_str, name in DEMO_HOLIDAYS_2026:
                conn.execute(
                    insert(holidays).values(
                        tenant_id=tenant_id,
                        date=date.fromisoformat(date_str),
                        name=name,
                    )
                )

            print("  · extra leave types (Maternity / Paternity / Bereavement)")
            for code, name, paid in DEMO_EXTRA_LEAVE_TYPES:
                conn.execute(
                    insert(leave_types).values(
                        tenant_id=tenant_id,
                        code=code,
                        name=name,
                        is_paid=paid,
                    )
                )

            print("  · shift policies (Fixed / Flex / Ramadan / Custom)")
            policy_ids = _seed_demo_policies(
                conn, tenant_id=tenant_id
            )

            print("  · custom fields (Badge / Contract / Joining)")
            for spec in (
                {"name": "Badge Number", "code": "badge_no",
                 "type": "text", "required": True, "display_order": 0},
                {"name": "Contract Type", "code": "contract_type",
                 "type": "select",
                 "options": ["Permanent", "Contract", "Intern"],
                 "required": False, "display_order": 1},
                {"name": "Joining Date", "code": "joining_date",
                 "type": "date", "required": False, "display_order": 2},
            ):
                conn.execute(
                    insert(custom_fields).values(
                        tenant_id=tenant_id,
                        **spec,
                    )
                )

            print("  · 25 employees + 1 honeypot (DEMO0099)")
            employees_by_code = _seed_demo_employees(
                conn, tenant_id=tenant_id
            )

            print("  · users (Admin / HR / 5 dept managers / matrix / dual / 5 emp logins)")
            user_creds, user_ids = _seed_demo_users(
                conn, tenant_id=tenant_id
            )

            print("  · manager assignments (Eng manager → all Eng employees, primary)")
            _seed_demo_manager_assignments(
                conn,
                tenant_id=tenant_id,
                user_ids=user_ids,
                employees_by_code=employees_by_code,
            )

            write_seed_audit(
                conn,
                tenant_id=tenant_id,
                action="pre_omran_reset_seed.demo_tenant",
                entity_type="tenant",
                entity_id=str(tenant_id),
                after={
                    "slug": DEMO_SLUG,
                    "schema": _demo_schema(),
                    "departments": len(DEMO_DEPARTMENTS),
                    "employees": 25,
                    "users": len(user_ids),
                    "policies": len(policy_ids),
                },
            )

    creds.users = user_creds
    creds.notes = [
        f"Honeypot employee: DEMO0099 'Test Crossover' (no login)",
        f"25 employees DEMO0001–DEMO0025 across 5 departments + honeypot",
    ]
    return creds


def _seed_demo_policies(
    conn: Connection, *, tenant_id: int
) -> dict[str, int]:
    today = date.today()

    def ins(name: str, ptype: str, config: dict[str, Any], **extras: Any) -> int:
        return int(
            conn.execute(
                insert(shift_policies).values(
                    tenant_id=tenant_id,
                    name=name,
                    type=ptype,
                    config=config,
                    active_from=today,
                    **extras,
                ).returning(shift_policies.c.id)
            ).scalar_one()
        )

    pids: dict[str, int] = {}

    pids["fixed"] = ins(
        "Office Default",
        "Fixed",
        {"start": "07:30", "end": "15:30",
         "grace_minutes": 15, "required_hours": 8},
    )

    pids["flex"] = ins(
        "Flex Engineers",
        "Flex",
        {
            "in_window_start": "07:00", "in_window_end": "09:00",
            "out_window_start": "15:00", "out_window_end": "17:00",
            "required_minutes": 480, "grace_minutes": 15,
        },
    )

    pids["ramadan"] = ins(
        "Ramadan 2026",
        "Ramadan",
        # Date range + custom_inner_type live inside ``config``;
        # the resolver lifts them onto the in-memory ShiftPolicy.
        # The DB table doesn't carry top-level columns for them.
        {
            "start": "08:00", "end": "14:00",
            "grace_minutes": 10, "required_minutes": 360,
            "start_date": "2026-02-18", "end_date": "2026-03-19",
        },
    )

    # Custom — pick the next upcoming Friday for simplicity.
    days_until_friday = (4 - today.weekday()) % 7 or 7
    from datetime import timedelta  # local import keeps top clean

    next_fri = today + timedelta(days=days_until_friday)
    pids["custom"] = ins(
        "Half-day Friday",
        "Custom",
        {
            "start": "08:00", "end": "12:00",
            "grace_minutes": 10, "required_minutes": 240,
            "start_date": next_fri.isoformat(),
            "end_date": next_fri.isoformat(),
            "inner_type": "Fixed",
        },
    )

    # Tenant-default = Office Default. Engineering gets Flex.
    conn.execute(
        insert(policy_assignments).values(
            tenant_id=tenant_id,
            policy_id=pids["fixed"],
            scope_type="tenant",
            scope_id=None,
            active_from=today,
        )
    )
    eng_dept_id = int(
        conn.execute(
            text("SELECT id FROM departments WHERE tenant_id=:t AND code='ENG'"),
            {"t": tenant_id},
        ).scalar_one()
    )
    conn.execute(
        insert(policy_assignments).values(
            tenant_id=tenant_id,
            policy_id=pids["flex"],
            scope_type="department",
            scope_id=eng_dept_id,
            active_from=today,
        )
    )
    return pids


# Distribution: 8 ENG, 6 OPS, 4 SAL, 4 FIN, 3 ADM = 25, plus honeypot.
DEMO_EMP_DISTRIBUTION: tuple[tuple[str, int], ...] = (
    ("ENG", 8), ("OPS", 6), ("SAL", 4), ("FIN", 4), ("ADM", 3),
)


def _email_from_name(full_name: str, domain: str) -> str:
    """``Aisha Al-Hinai`` → ``aisha.al-hinai@domain``."""

    parts = full_name.lower().replace(".", "").split()
    if len(parts) == 1:
        local = parts[0]
    else:
        local = f"{parts[0]}.{'-'.join(parts[1:])}"
    # Strip anything that's not alpha/dot/dash.
    local = re.sub(r"[^a-z0-9.\-]", "", local)
    return f"{local}@{domain}"


def _seed_demo_employees(
    conn: Connection, *, tenant_id: int
) -> dict[str, int]:
    dept_lookup = department_ids_by_code(conn, tenant_id=tenant_id)
    out: dict[str, int] = {}
    name_idx = 0
    code_idx = 1
    for dept_code, count in DEMO_EMP_DISTRIBUTION:
        for _ in range(count):
            code = f"DEMO{code_idx:04d}"
            name = DEMO_NAMES[name_idx]
            email = _email_from_name(name, DEMO_DOMAIN)
            emp_id = create_employee(
                conn,
                tenant_id=tenant_id,
                employee_code=code,
                full_name=name,
                email=email,
                department_code=dept_code,
                department_id_lookup=dept_lookup,
            )
            out[code] = emp_id
            code_idx += 1
            name_idx += 1
    # Honeypot — same name as the cross-tenant pair documented in the
    # M2 test doc. No matching user record.
    out["DEMO0099"] = create_employee(
        conn,
        tenant_id=tenant_id,
        employee_code="DEMO0099",
        full_name="Test Crossover",
        email="crossover@mts-demo.example.com",
        department_code="ENG",
        department_id_lookup=dept_lookup,
    )
    return out


def _seed_demo_users(
    conn: Connection, *, tenant_id: int
) -> tuple[list[SeededUser], dict[str, int]]:
    rid = role_ids_by_code(conn, tenant_id=tenant_id)
    did = department_ids_by_code(conn, tenant_id=tenant_id)

    ucreds: list[SeededUser] = []
    user_ids: dict[str, int] = {}

    def add(label: str, email: str, full_name: str, roles: list[str],
            depts: list[str], note: str = "") -> int:
        pw = gen_password()
        uid = create_user(
            conn,
            tenant_id=tenant_id,
            email=email,
            full_name=full_name,
            password=pw,
            role_codes=roles,
            department_codes=depts,
            role_id_lookup=rid,
            department_id_lookup=did,
        )
        ucreds.append(SeededUser(role_label=label, email=email, password=pw, note=note))
        user_ids[email] = uid
        return uid

    add("Admin", "admin@mts-demo.example.com", "MTS Demo Admin", ["Admin"], [])
    add("HR", "hr@mts-demo.example.com", "MTS Demo HR", ["HR"], [])
    add("Manager Eng", "manager.eng@mts-demo.example.com", "Engineering Manager",
        ["Manager"], ["ENG"])
    add("Manager Ops", "manager.ops@mts-demo.example.com", "Operations Manager",
        ["Manager"], ["OPS"])
    add("Manager Sales", "manager.sales@mts-demo.example.com", "Sales Manager",
        ["Manager"], ["SAL"])
    add("Manager Fin", "manager.fin@mts-demo.example.com", "Finance Manager",
        ["Manager"], ["FIN"])
    add("Manager Admin", "manager.admin@mts-demo.example.com", "Admin Manager",
        ["Manager"], ["ADM"])
    add("Manager Matrix", "manager.matrix@mts-demo.example.com",
        "Matrix Manager (Eng+Sales)", ["Manager"], ["ENG", "SAL"],
        note="multi-department manager")
    add("HR + Manager Ops", "dual.role@mts-demo.example.com",
        "Dual-role User (HR + Manager)", ["HR", "Manager"], ["OPS"],
        note="dual role — exercises the role switcher (P7)")

    # 5 employee-logins, picked one from each department. Match the
    # employee email exactly so the User↔Employee join works.
    emp_logins = (
        ("Employee Eng",   "dawud.al-farsi@mts-demo.example.com",     "Dawud Al-Farsi", "ENG"),
        ("Employee Ops",   "aisha.al-hinai@mts-demo.example.com",     "Aisha Al-Hinai", "OPS"),
        ("Employee Sales", "khalid.al-saadi@mts-demo.example.com",    "Khalid Al-Saadi", "SAL"),
        ("Employee Fin",   "salma.al-maamari@mts-demo.example.com",   "Salma Al-Maamari", "FIN"),
        ("Employee Admin", "nasser.al-balushi@mts-demo.example.com",  "Nasser Al-Balushi", "ADM"),
    )
    for label, email, name, dept in emp_logins:
        add(label, email, name, ["Employee"], [dept])

    return ucreds, user_ids


def _seed_demo_manager_assignments(
    conn: Connection,
    *,
    tenant_id: int,
    user_ids: dict[str, int],
    employees_by_code: dict[str, int],
) -> None:
    mgr_eng = user_ids["manager.eng@mts-demo.example.com"]
    eng_codes = [f"DEMO{i:04d}" for i in range(1, 9)]  # DEMO0001..0008
    for code in eng_codes:
        emp_id = employees_by_code[code]
        assign_manager(
            conn,
            tenant_id=tenant_id,
            manager_user_id=mgr_eng,
            employee_id=emp_id,
            is_primary=True,
        )


# ────────────────────────────────────────────────────────────────────
# Real corporate seed
# ────────────────────────────────────────────────────────────────────


def _real_corporate_domain() -> str:
    """Default domain for the real-corp seeded emails.

    The prompt's example was ``mts.local``, but ``.local`` is RFC-
    2606-reserved and rejected by ``email-validator``'s strict
    mode (P28 backlog item B-4). We default to a
    ``.example.com`` derivative — the other RFC-2606-reserved
    namespace, but one the validator does accept — so the seeded
    accounts work through the login API out of the box.
    Override with the ``REAL_CORPORATE_DOMAIN`` constant at the
    top of the file if your setup needs a real DNS-resolvable
    domain.
    """

    if REAL_CORPORATE_DOMAIN:
        return REAL_CORPORATE_DOMAIN
    if REAL_CORPORATE_SLUG == "mts-office":
        return "mts.example.com"
    return f"{REAL_CORPORATE_SLUG}.example.com"


def _real_corporate_schema() -> str:
    # Single derivation helper — same one ``provision_tenant`` uses
    # so the schema name printed during a dry run matches the value
    # that lands in ``public.tenants.schema_name``.
    from maugood.tenants.slug import schema_name_for_slug  # noqa: PLC0415

    return schema_name_for_slug(REAL_CORPORATE_SLUG)


def _seed_real_corporate(
    engine: Engine, *, tenant_id: int
) -> TenantCredentials:
    schema = _real_corporate_schema()
    domain = _real_corporate_domain()
    print(f"\n▸ Seeding {REAL_CORPORATE_NAME} ({schema}, tenant_id={tenant_id})...")
    creds = TenantCredentials(slug=REAL_CORPORATE_SLUG, display_name=REAL_CORPORATE_NAME)

    from maugood.db import tenant_context  # noqa: PLC0415

    with tenant_context(schema):
        with engine.begin() as conn:
            print("  · departments (Office, Operations)")
            for code, name in REAL_DEPARTMENTS:
                ensure_department(
                    conn, tenant_id=tenant_id, code=code, name=name
                )

            print(f"  · branding ({REAL_BRANDING['primary_color_key']} + "
                  f"{REAL_BRANDING['font_key']})")
            _set_branding(conn, tenant_id=tenant_id, branding=REAL_BRANDING)

            print("  · 1 Fixed policy 'Office Hours' 09:00–18:00")
            policy_id = int(
                conn.execute(
                    insert(shift_policies).values(
                        tenant_id=tenant_id,
                        name="Office Hours",
                        type="Fixed",
                        config={
                            "start": "09:00", "end": "18:00",
                            "grace_minutes": 15,
                            "required_hours": 8,
                        },
                        active_from=date.today(),
                    ).returning(shift_policies.c.id)
                ).scalar_one()
            )
            conn.execute(
                insert(policy_assignments).values(
                    tenant_id=tenant_id,
                    policy_id=policy_id,
                    scope_type="tenant",
                    scope_id=None,
                    active_from=date.today(),
                )
            )

            print("  · users (Admin / HR / Manager / Employee)")
            rid = role_ids_by_code(conn, tenant_id=tenant_id)
            did = department_ids_by_code(conn, tenant_id=tenant_id)
            spec = (
                ("Admin",    f"admin@{domain}",    f"{REAL_CORPORATE_NAME} Admin",   ["Admin"],   []),
                ("HR",       f"hr@{domain}",       f"{REAL_CORPORATE_NAME} HR",      ["HR"],      []),
                ("Manager",  f"manager@{domain}",  f"{REAL_CORPORATE_NAME} Manager", ["Manager"], ["OFC"]),
                ("Employee", f"employee@{domain}", REAL_TEST_EMPLOYEE_NAME,           ["Employee"], ["OFC"]),
            )
            user_ids: dict[str, int] = {}
            for label, email, name, roles, depts in spec:
                pw = gen_password()
                user_ids[email] = create_user(
                    conn,
                    tenant_id=tenant_id,
                    email=email,
                    full_name=name,
                    password=pw,
                    role_codes=roles,
                    department_codes=depts,
                    role_id_lookup=rid,
                    department_id_lookup=did,
                )
                creds.users.append(SeededUser(role_label=label, email=email, password=pw))

            print(f"  · employee record matching the Employee user")
            slug_upper = REAL_CORPORATE_SLUG.upper().replace("-", "_")
            test_emp_code = f"{slug_upper}0001"
            create_employee(
                conn,
                tenant_id=tenant_id,
                employee_code=test_emp_code,
                full_name=REAL_TEST_EMPLOYEE_NAME,
                email=f"employee@{domain}",
                department_code="OFC",
                department_id_lookup=did,
            )

            print("  · placeholder camera 'Office Camera 1' (no RTSP yet)")
            # Encrypted RTSP URL stored as a placeholder so the row
            # is visible in the Cameras UI; the operator MUST update
            # it via the UI before testing.
            from maugood.cameras import rtsp as rtsp_io  # noqa: PLC0415

            placeholder_url = "rtsp://placeholder.invalid/PLACEHOLDER"
            encrypted = rtsp_io.encrypt_url(placeholder_url)
            conn.execute(
                insert(cameras).values(
                    tenant_id=tenant_id,
                    name="Office Camera 1",
                    location="Reception",
                    rtsp_url_encrypted=encrypted,
                    enabled=False,
                )
            )

            write_seed_audit(
                conn,
                tenant_id=tenant_id,
                action="pre_omran_reset_seed.real_corporate",
                entity_type="tenant",
                entity_id=str(tenant_id),
                after={
                    "schema": schema,
                    "test_employee_code": test_emp_code,
                    "test_employee_name": REAL_TEST_EMPLOYEE_NAME,
                    "rtsp_placeholder": True,
                },
            )

    creds.notes = [
        f"Test Employee record: {test_emp_code} \"{REAL_TEST_EMPLOYEE_NAME}\""
        f" (matches Employee user)",
        "Camera 'Office Camera 1' is a placeholder — update RTSP via the UI",
    ]
    return creds


# ────────────────────────────────────────────────────────────────────
# Credentials output
# ────────────────────────────────────────────────────────────────────


def _format_credentials(
    super_admins: list[SeededUser],
    demo: TenantCredentials,
    real: TenantCredentials,
) -> str:
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M GST")
    border = "═" * 60
    lines = [
        f"╔{border}╗",
        "║         MAUGOOD v1.0 — PRE-OMRAN VALIDATION CREDENTIALS      ║",
        f"║         Generated: {now_iso:<38} ║",
        "║         WARNING: dev/test credentials only — DO NOT USE    ║",
        "║         IN PRODUCTION. credentials.txt is gitignored.      ║",
        f"╚{border}╝",
        "",
        "── MTS SUPER-ADMIN (login at /super-admin/login) ──────────",
    ]
    for u in super_admins:
        lines.append(f"{u.email:<28} | {u.password}")

    lines += [
        "",
        f"── TENANT: {DEMO_NAME} (synthetic test data) ──────────────",
        # The slug printed here is the friendly identifier from
        # ``public.tenants.slug`` — what the API expects on
        # ``POST /api/auth/login`` and what the frontend tenant
        # picker collects from the operator. The internal Postgres
        # schema name (``tenant_<slug>``) is deliberately not
        # printed; it's a one-way derivation handled by
        # provisioning.
        f"URL: http://localhost:5173    Tenant slug: {DEMO_SLUG}",
        "",
    ]
    width = max((len(u.role_label) for u in demo.users), default=10) + 1
    for u in demo.users:
        line = f"{u.role_label:<{width}} | {u.email:<32} | {u.password}"
        if u.note:
            line += f"   ({u.note})"
        lines.append(line)
    if demo.notes:
        lines.append("")
        for n in demo.notes:
            lines.append(f"  · {n}")

    lines += [
        "",
        f"── TENANT: {REAL_CORPORATE_NAME} (real corporate, real camera) ──",
        f"URL: http://localhost:5173    Tenant slug: {REAL_CORPORATE_SLUG}",
        "",
    ]
    width = max((len(u.role_label) for u in real.users), default=10) + 1
    for u in real.users:
        lines.append(f"{u.role_label:<{width}} | {u.email:<32} | {u.password}")
    if real.notes:
        lines.append("")
        for n in real.notes:
            lines.append(f"  · {n}")

    slug_upper = REAL_CORPORATE_SLUG.upper().replace("-", "_")
    lines += [
        "",
        "── NEXT STEPS ─────────────────────────────────────────────",
        "1. credentials.txt is gitignored — verified by the script.",
        "2. Log in as Super-Admin first; verify both tenants are visible.",
        "3. Validate demo tenant per docs/testing/pre-omran-validation.md",
        "4. Configure your office camera RTSP via the Cameras page on the",
        "   real corporate tenant.",
        f"5. Upload your face photo for {slug_upper}0001.",
        "6. Walk past the camera. Verify identification, attendance,",
        "   reports.",
        "7. Run through the validation checklist end-to-end before",
        "   showing Omran.",
        "",
    ]
    return "\n".join(lines)


def _is_credentials_txt_gitignored(repo_root: Path) -> bool:
    """Authoritative check: ``git check-ignore``. Falls back to a
    text scan of ``.gitignore`` when ``git`` isn't available (the
    backend docker container doesn't ship the binary).

    Both paths return ``True`` only when ``credentials.txt`` is in
    the ignore list. The text fallback is conservative — matches
    only on the literal pattern ``credentials.txt`` at the start of
    a line, which is what we just added in this phase.
    """

    try:
        check = subprocess.run(
            ["git", "check-ignore", "credentials.txt"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        return check.returncode == 0
    except FileNotFoundError:
        # git not on PATH (typical inside our backend container).
        gitignore = repo_root / ".gitignore"
        if not gitignore.is_file():
            return False
        for raw in gitignore.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            # Conservative: literal match on the file name. Globbed
            # patterns (``**/credentials.*``) wouldn't be caught,
            # but the seed script's gitignore patch is literal, so
            # the conservatism doesn't bite us.
            if line == "credentials.txt":
                return True
        return False


def _resolve_repo_root() -> Path:
    """Find the host's repo root from inside the container.

    Order of preference:

    1. ``MAUGOOD_REPO_ROOT`` env override.
    2. ``/repo`` — the bind-mount the docker-compose.yml ships
       (P28-followup) so the container can read the host's
       .gitignore + write credentials.txt to the host's repo
       root.
    3. ``Path(__file__).resolve().parents[2]`` — the natural path
       when running this script directly on the host (no docker).
    """

    override = os.environ.get("MAUGOOD_REPO_ROOT")
    if override:
        return Path(override)
    repo_mount = Path("/repo")
    if repo_mount.is_dir() and (repo_mount / ".gitignore").is_file():
        return repo_mount
    return Path(__file__).resolve().parents[2]


def _write_credentials(content: str) -> Path:
    repo_root = _resolve_repo_root()
    target = repo_root / "credentials.txt"

    if not _is_credentials_txt_gitignored(repo_root):
        print(
            "\n  ERROR: credentials.txt is NOT gitignored.",
            file=sys.stderr,
        )
        print(
            "  Refusing to write the file. Add 'credentials.txt' to "
            ".gitignore and re-run.",
            file=sys.stderr,
        )
        sys.exit(2)

    target.write_text(content, encoding="utf-8")
    target.chmod(0o600)
    return target


# ────────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────────


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Wipe + re-seed Maugood with rich validation data.",
    )
    p.add_argument(
        "--skip-real",
        action="store_true",
        help="Skip the real corporate tenant (demo + super-admin only).",
    )
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(level=logging.WARNING, format="[seed] %(message)s")
    args = _parse_args(argv)

    # Three brakes — the prompt's red line.
    _placeholder_check()
    _slug_check(REAL_CORPORATE_SLUG)
    _env_check()

    backend_dir = Path(__file__).resolve().parent.parent
    engine = make_admin_engine()
    try:
        _employee_count_check(engine)
        _typed_confirm()

        # Phase 1: wipe + re-migrate public.
        _wipe_database(engine)
    finally:
        engine.dispose()

    _migrate_public(backend_dir)

    # Phase 2: provision tenants. Each one gets its own engine cycle
    # so a connection-pool quirk doesn't span the wipe. Pass the
    # friendly slug; ``provision_tenant`` derives the schema name.
    print(f"\n▸ Provisioning slug={DEMO_SLUG!r}...")
    demo_result = provision_tenant(
        slug=DEMO_SLUG, name=DEMO_NAME, skip_default_admin=True,
    )
    print(
        f"  provisioned tenant_id={demo_result['tenant_id']} "
        f"schema={demo_result['schema']}"
    )

    real_result: dict[str, Any] = {}
    real_creds: Optional[TenantCredentials] = None
    if not args.skip_real:
        print(f"\n▸ Provisioning slug={REAL_CORPORATE_SLUG!r} ...")
        real_result = provision_tenant(
            slug=REAL_CORPORATE_SLUG,
            name=REAL_CORPORATE_NAME,
            skip_default_admin=True,
        )
        print(
            f"  provisioned tenant_id={real_result['tenant_id']} "
            f"schema={real_result['schema']}"
        )
    else:
        print("\n▸ Skipping real corporate tenant per --skip-real")

    print(
        "\n▸ NOTE: tenant_omran is intentionally NOT provisioned here.\n"
        "  Omran's tenant gets clean real data at P29 cutover, not\n"
        "  dummy data. See docs/phases/P29 (when it lands)."
    )

    # Phase 3: seed.
    engine = make_admin_engine()
    try:
        super_creds = _seed_super_admins(engine)
        demo_creds = _seed_demo_tenant(
            engine, tenant_id=int(demo_result["tenant_id"])
        )
        if real_result:
            real_creds = _seed_real_corporate(
                engine, tenant_id=int(real_result["tenant_id"])
            )
    finally:
        engine.dispose()

    # Phase 4: write credentials.
    print("\n▸ Generating credentials...")
    if real_creds is None:
        # Build a stub so the formatter has something to render.
        real_creds = TenantCredentials(
            slug=REAL_CORPORATE_SLUG, display_name=REAL_CORPORATE_NAME,
            notes=["(skipped — --skip-real was set)"],
        )
    content = _format_credentials(super_creds, demo_creds, real_creds)
    target = _write_credentials(content)

    print("\n" + "═" * 64)
    print(content)
    print("═" * 64)
    print(f"\n✓ Credentials written to {target}")
    print(f"✓ {len(super_creds)} super-admins, "
          f"{len(demo_creds.users)} demo users, "
          f"{len(real_creds.users)} real-corp users")
    print("\nNext: open credentials.txt and follow")
    print("      docs/testing/pre-omran-validation.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
