"""Fresh-init API smoke — probes every first-paint endpoint for 5xx.

The goal isn't end-to-end correctness — it's catching the specific
class of bug where an API 500s on a clean database because it
assumes seed data / cameras / clips / attendance rows exist. Run this
against a freshly provisioned tenant (zero cameras, zero employees,
zero clips, zero attendance) and it'll print a punch list of any
endpoint that returned 5xx.

Usage::

    # Inside the backend container (cookies are sent to localhost):
    docker compose exec backend python -m scripts.smoke_fresh_init \\
        --email admin@pilot.maugood --password '...'

    # Or against a remote stack:
    docker compose exec backend python -m scripts.smoke_fresh_init \\
        --base-url http://nginx --email admin@pilot.maugood --password '...'

    # Multi-tenant: pass the slug.
    docker compose exec backend python -m scripts.smoke_fresh_init \\
        --tenant-slug mts_demo --email admin@... --password '...'

Exit code is zero iff every probed endpoint returned <500. Per-endpoint
status is printed as a table at the end so you can also eyeball the
mix of 2xx / 4xx / 5xx.

The endpoint list is grouped by the page that triggers it on first
paint. To keep the script honest, **only GET endpoints** are probed —
fresh-init issues are read-side. Add new endpoints when you add new
pages; the script is data-driven (see ``PAGE_PROBES`` below).
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

try:
    import requests
except ImportError:  # pragma: no cover
    print("requests not installed — pip install requests", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# Endpoint catalog
# ---------------------------------------------------------------------------


@dataclass
class Probe:
    name: str
    path: str
    # Some endpoints are role-gated; for an Admin smoke we expect 200.
    # Set ``expected_status_in`` if a 404/403 is also fine (e.g. an
    # employee detail endpoint when no employees exist).
    expected_status_in: tuple[int, ...] = field(default_factory=lambda: (200, 204))


def _today() -> str:
    return date.today().isoformat()


def _this_month() -> str:
    today = date.today()
    return f"{today.year:04d}-{today.month:02d}"


def _last_30_days() -> tuple[str, str]:
    end = date.today()
    start = end - timedelta(days=30)
    return start.isoformat(), end.isoformat()


def build_probes() -> dict[str, list[Probe]]:
    """Return ``{page_label: [Probe, ...]}`` — one probe per first-paint
    API call. Add entries here when you ship new pages.
    """

    start, end = _last_30_days()
    month = _this_month()
    today = _today()

    return {
        "Auth + shell": [
            Probe("auth.me", "/api/auth/me"),
            # Role / theme / density / language are PATCH-only — skipped.
        ],
        "Employees": [
            Probe(
                "employees.list",
                "/api/employees?page=1&page_size=50&sort_by=employee_code&sort_dir=asc",
            ),
            Probe("departments.list", "/api/departments"),
            Probe("delete-requests.list", "/api/delete-requests"),
            Probe("custom-fields.list", "/api/custom-fields"),
        ],
        "Approvals + Requests": [
            Probe("requests.inbox.pending", "/api/requests/inbox/pending"),
            Probe("requests.inbox.decided", "/api/requests/inbox/decided"),
            Probe("requests.inbox.summary", "/api/requests/inbox/summary"),
            Probe("requests.list.all", "/api/requests"),
            Probe(
                "request-reason-categories.list",
                "/api/request-reason-categories",
            ),
        ],
        "Cameras + Live Capture": [
            Probe("cameras.list", "/api/cameras"),
            Probe("live-capture.cameras", "/api/live-capture/cameras"),
        ],
        "Person Clips + Clip Analytics": [
            Probe("person-clips.list", "/api/person-clips?page=1&page_size=24"),
            Probe("person-clips.stats", "/api/person-clips/stats"),
            Probe("person-clips.uc-comparison", "/api/person-clips/uc-comparison"),
            Probe("person-clips.system-stats", "/api/person-clips/system-stats"),
            Probe("clip-pipeline.status", "/api/clip-pipeline/status"),
            Probe(
                "person-clips.matched-employee-empty",
                # Non-existent employee id — should return empty list, not 500.
                "/api/person-clips?matched_employee_id=999999&page=1&page_size=24",
            ),
        ],
        "Operations + Pipeline Monitor": [
            Probe("operations.workers", "/api/operations/workers"),
            Probe("operations.pipeline", "/api/operations/pipeline"),
        ],
        "Attendance": [
            Probe("attendance.today", f"/api/attendance?date={today}"),
            Probe("attendance.me.recent", "/api/attendance/me/recent?days=7"),
            Probe(
                "attendance.calendar.company",
                f"/api/attendance/calendar/company?month={month}",
            ),
        ],
        "Camera Logs + Detection Events": [
            Probe(
                "detection-events.list",
                f"/api/detection-events?start={start}T00:00:00&end={end}T23:59:59",
            ),
        ],
        "Policies + Leave/Calendar": [
            Probe("policies.list", "/api/policies"),
            Probe("policy-assignments.list", "/api/policy-assignments"),
            Probe("leave-types.list", "/api/leave-types"),
            Probe("holidays.list", "/api/holidays"),
            Probe("approved-leaves.list", "/api/approved-leaves"),
            Probe("tenant-settings.get", "/api/tenant-settings"),
        ],
        "Manager assignments": [
            Probe("manager-assignments.list", "/api/manager-assignments"),
        ],
        "Notifications": [
            Probe("notifications.list", "/api/notifications"),
            Probe("notification-preferences.get", "/api/notification-preferences"),
        ],
        "Reports": [
            # Reports endpoints are POST — no first-paint API call from the
            # Reports page itself beyond department/employee selectors.
        ],
        "Audit Log": [
            Probe("audit-log.list", "/api/audit-log"),
        ],
        "System": [
            Probe("system.health", "/api/system/health"),
            Probe("system.cameras-health", "/api/system/cameras-health"),
            Probe("system.detection-config", "/api/system/detection-config"),
            Probe("system.tracker-config", "/api/system/tracker-config"),
        ],
        "Branding": [
            Probe("branding.get", "/api/branding"),
        ],
        "Users": [
            Probe(
                "users.list",
                "/api/users",
                # Endpoint may not exist on every build — accept 404.
                expected_status_in=(200, 404),
            ),
        ],
    }


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


@dataclass
class Result:
    page: str
    name: str
    path: str
    status: int
    is_5xx: bool
    body_excerpt: str


def run(
    *,
    base_url: str,
    email: str,
    password: str,
    tenant_slug: Optional[str],
) -> int:
    session = requests.Session()

    # --- 1. Login -----------------------------------------------------------
    login_body: dict[str, object] = {"email": email, "password": password}
    if tenant_slug:
        login_body["tenant_slug"] = tenant_slug
    print(f"\n  Logging in as {email}…")
    try:
        resp = session.post(
            f"{base_url}/api/auth/login", json=login_body, timeout=15
        )
    except requests.RequestException as exc:
        print(
            f"  login failed at network level: {exc}\n"
            f"  Is the backend reachable at {base_url}?",
            file=sys.stderr,
        )
        return 2
    if resp.status_code != 200:
        print(
            f"  login failed (HTTP {resp.status_code}): {resp.text[:200]}",
            file=sys.stderr,
        )
        return 2
    print("  login OK — session cookie set")

    # --- 2. Probe -----------------------------------------------------------
    results: list[Result] = []
    probes = build_probes()
    print(f"  Probing {sum(len(v) for v in probes.values())} endpoints…\n")

    for page, items in probes.items():
        for p in items:
            url = f"{base_url}{p.path}"
            try:
                r = session.get(url, timeout=20)
                status = r.status_code
                excerpt = r.text[:200].replace("\n", " ")
            except requests.RequestException as exc:
                status = -1
                excerpt = f"network: {exc}"
            results.append(
                Result(
                    page=page,
                    name=p.name,
                    path=p.path,
                    status=status,
                    is_5xx=status >= 500,
                    body_excerpt=excerpt,
                )
            )

    # --- 3. Report ----------------------------------------------------------
    print("=" * 80)
    print(f"  Fresh-init smoke results ({len(results)} probes)")
    print("=" * 80)

    by_page: dict[str, list[Result]] = {}
    for r in results:
        by_page.setdefault(r.page, []).append(r)

    counts = {"ok": 0, "client_err": 0, "server_err": 0, "network": 0}

    for page, items in by_page.items():
        print(f"\n  {page}")
        print("  " + "-" * (len(page)))
        for r in items:
            if r.status == -1:
                tag = "NETWORK"
                counts["network"] += 1
            elif r.is_5xx:
                tag = f"!! 5xx ({r.status})"
                counts["server_err"] += 1
            elif r.status >= 400:
                tag = f" {r.status}"
                counts["client_err"] += 1
            else:
                tag = f"OK {r.status}"
                counts["ok"] += 1
            print(f"    [{tag:>14}]  {r.name:<40s}  {r.path}")
            if r.is_5xx or r.status == -1:
                print(f"        body: {r.body_excerpt}")

    print("\n" + "=" * 80)
    print(
        f"  Summary: {counts['ok']} ok, {counts['client_err']} 4xx, "
        f"{counts['server_err']} 5xx, {counts['network']} network"
    )
    print("=" * 80)

    if counts["server_err"] > 0:
        print(
            f"\n  FAIL — {counts['server_err']} endpoint(s) returned 5xx. "
            f"See `body:` lines above and `backend/logs/app.log` for tracebacks.",
            file=sys.stderr,
        )
        return 1

    if counts["network"] > 0:
        print(
            f"\n  WARN — {counts['network']} endpoint(s) errored at network "
            f"level (server not reachable?).",
            file=sys.stderr,
        )
        return 1

    print("\n  PASS — no 5xx detected on fresh-init APIs.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Hit every first-paint API endpoint and flag any 5xx. "
            "Intended for running against a freshly provisioned tenant."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("MAUGOOD_SMOKE_BASE_URL", "http://localhost:8000"),
        help="Base URL (default: http://localhost:8000)",
    )
    parser.add_argument(
        "--email",
        default=os.environ.get("MAUGOOD_SMOKE_EMAIL"),
        help="Admin email (or set MAUGOOD_SMOKE_EMAIL)",
    )
    parser.add_argument(
        "--password",
        default=os.environ.get("MAUGOOD_SMOKE_PASSWORD"),
        help="Admin password (or set MAUGOOD_SMOKE_PASSWORD)",
    )
    parser.add_argument(
        "--tenant-slug",
        default=os.environ.get("MAUGOOD_SMOKE_TENANT_SLUG"),
        help=(
            "Tenant slug for multi-tenant mode. Omit in single-tenant "
            "mode."
        ),
    )
    args = parser.parse_args()

    if not args.email or not args.password:
        print(
            "ERROR — --email and --password are required (or set "
            "MAUGOOD_SMOKE_EMAIL / MAUGOOD_SMOKE_PASSWORD).",
            file=sys.stderr,
        )
        return 2

    return run(
        base_url=args.base_url.rstrip("/"),
        email=args.email,
        password=args.password,
        tenant_slug=args.tenant_slug,
    )


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
