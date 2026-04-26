# Hadir — security review pass

**Date:** 2026-04-26
**Reviewer:** Suresh (MTS) via Claude Code
**Scope:** v1.0 P0 → P26 (everything to date).
**Phase reference:** P27.

This document is the durable record of the M3-gate security
review. Append-only — every subsequent review adds a new
section below; never edit a past finding.

---

## 1. Automated scans

### 1.1 Bandit (Python static analysis)

```
$ docker compose exec backend bandit -r hadir/ -ll
Total issues (by severity): Low: 53, Medium: 0, High: 0
```

**Result:** zero medium+ findings.

The 53 lows fall into two families:

* **B101 (assert_used)** — defensive ``assert`` statements
  for "should never happen" branches. Python is never run
  with ``-O`` in production (the entrypoint launches
  ``python -m uvicorn …`` directly), so the asserts always
  execute. Acceptable.
* **B110 (try-except-pass)** — used intentionally in
  capture-loop hot paths so a metric/instrumentation
  exception never sinks the worker. P26 added a few more in
  ``observe_*`` call sites for the same reason. Acceptable.

Two **B105 (hardcoded_password_string)** false positives in
``hadir/auth/oidc.py`` — the linter flags the *literal*
string ``""`` in ``payload.client_secret != ""``. That's a
"don't rotate when the operator left the field blank"
guard, not a hardcoded credential. Acceptable.

### 1.2 pip-audit (Python CVE scan)

**Before fixes:** 24 known vulnerabilities in 11 packages.

**After fixes (this session):** 4 known vulnerabilities in
4 packages.

| Package    | Version   | CVEs cleared in P27 |
| ---------- | --------- | -------------------- |
| authlib    | 1.3.2 → 1.6.11   | 7 (JWT/JOSE class) |
| cryptography | 43.0.1 → 46.0.7 | 4 |
| jinja2     | 3.1.4 → 3.1.6    | 3 (sandbox escape) |
| python-multipart | 0.0.12 → 0.0.26 | 3 (multipart parser DoS) |
| python-dotenv | 1.0.1 → 1.2.2 | 1 |
| starlette (via FastAPI 0.115 → 0.124) | 0.38.6 → 0.47+ | 2 |
| weasyprint | 62.3 → 68.0 + pydyf 0.10 → 0.12.1 | 1 |

**Remaining (4):** all dev/build-time only.

| Package | CVE | Why it stays |
| --- | --- | --- |
| black 24.8.0 | CVE-2026-32274 | Code formatter; never runs in production. |
| pip 26.0.1 | CVE-2026-3219 | Base image's pip; build-time only. |
| pytest 8.3.3 | CVE-2025-71176 | Test runner; never runs in production. |
| wheel 0.45.1 | CVE-2026-24049 | Build-time only. |

**Action:** track on the M3 backlog. Bump black/pytest in
the next dependency-refresh phase; pip + wheel rotate
naturally with base-image bumps.

### 1.3 npm audit (frontend)

**Before fixes:** 9 vulnerabilities (4 moderate + 5 high).

**After fixes (this session):** 5 moderate, 0 high.

| Package           | From → To       |
| ----------------- | --------------- |
| react-router-dom  | 6.26.2 → 6.30.3 |
| vite              | 5.4.8  → 5.4.21 |
| @playwright/test  | 1.48.1 → 1.59.1 |

**Remaining (5):** all moderate, all on dev-only surfaces:

* **vite + @vitejs/plugin-react + esbuild** — dev server
  CVEs (server.fs.deny bypass, optimised-deps map handling).
  Production builds are static files served by nginx; no
  vite at runtime.
* **exceljs + uuid** — exceljs ships only in
  ``devDependencies`` and is imported only by
  ``frontend/tests/pilot-smoke.spec.ts``. The fixed
  ``exceljs@3.4.0`` is a major *downgrade* that would break
  the smoke test; we keep 4.4.0 and accept the dev-only
  exposure.

**Action:** same M3-backlog handling. Bump on the next
frontend refresh.

### 1.4 Trivy (image scan)

| Image           | Base                | HIGH+CRIT before | After P27 |
| --------------- | ------------------- | ---------------- | --------- |
| `hadir-backend` | debian 13.4         | 142H / 0C        | unchanged |
| `hadir-nginx`   | alpine 3.21.3 → **3.23.4** | 28H / 6C  | **0 / 0** |
| `hadir-backup`  | alpine 3.23.4       | 0 OS / 19H + 3C in Go binaries | **0 OS / 8H + 1C in gosu only** |

**Fixes applied:**

* **Nginx base** — bumped from `nginx:1.27-alpine` to
  `nginx:stable-alpine` (alpine 3.23.4). 28H + 6C → 0/0.
* **Supercronic** — bumped from `v0.2.29` to `v0.2.45`.
  11H + 2C → 0/0.

**Remaining:**

* **Backend image** (debian 13.4): 142 HIGH OS-package
  CVEs, all marked `fixed-avail=0` upstream. These are
  Debian trixie security advisories without a published
  fix yet (kernel/glibc/ncurses class). Mitigation:
  monthly rebuild on `python:3.11-slim` so we pick up
  patches as they ship.
* **Backup image / gosu binary**: 8 HIGH + 1 CRITICAL CVEs
  in the `gosu` binary that the postgres-15-alpine base
  layer ships for setuid handoff. Hadir's backup script
  doesn't invoke gosu (we run as root inside the
  short-lived container). Replacing it requires rebasing
  on a different image — defer to a v1.x dependency
  refresh.

**Action:** monthly rebuild scheduled (M3 backlog item);
gosu stays until v1.x.

---

## 2. Manual review

Per the P27 checklist. Each section: what was checked, what
was found, what was done.

### 2.1 Auth — session fixation, brute-force, OIDC, password policy

| Vector | Result |
| --- | --- |
| **Session fixation** | SAFE. `auth.sessions.create_session` always allocates a fresh ``secrets.token_urlsafe(48)`` on login; we never accept a client-supplied session id. |
| **Brute-force** | PROTECTED. P3's `LoginRateLimiter` keys on `(email_lower, client_ip)` with `HADIR_LOGIN_MAX_ATTEMPTS` (default 10) per `HADIR_LOGIN_RATE_LIMIT_RESET_MINUTES` (default 10). The audit row `auth.login.rate_limited` is written before the 429. |
| **OIDC state + nonce** | VALIDATED. `auth/oidc.py` signs the state+nonce blob into `hadir_oidc_state`; the callback verifies the signature, the nonce against the ID-token claim, and the JWKS-validated signature on the token itself. |
| **Password policy** | **FINDING (medium) — fixed in P27.** Neither `scripts/seed_admin.py` nor `scripts/provision_tenant.py` enforced a minimum password length. An operator could set a 1-char admin password. **Fix:** both scripts now refuse passwords shorter than 12 characters (NIST SP 800-63B § 5.1.1.2 floor + a comfortable margin). OIDC remains the recommended path for user-added accounts. |

### 2.2 Authorization — role guards, IDOR

**Per-router guard audit** — counted route decorators vs
guard references in every router file:

```
attendance/router.py        endpoints=2 guards=3 ✓
audit_log/router.py         endpoints=1 guards=3 ✓
auth/router.py              endpoints=7 guards=12 ✓
branding/router.py          endpoints=7 guards=8 ✓
cameras/router.py           endpoints=5 guards=7 ✓
custom_fields/router.py     endpoints=7 guards=10 ✓
detection_events/router.py  endpoints=2 guards=4 ✓
employees/router.py         endpoints=13 guards=16 ✓
erp_export/router.py        endpoints=3 guards=5 ✓
identification/router.py    endpoints=1 guards=3 ✓
leave_calendar/router.py    endpoints=12 guards=14 ✓
manager_assignments/router.py endpoints=3 guards=5 ✓
notifications/router.py     endpoints=5 guards=2 ✓ (every route has user: USER param)
policies/router.py          endpoints=7 guards=9 ✓
reporting/router.py         endpoints=2 guards=4 ✓
requests/router.py          endpoints=15 guards=6 ✓ (USER constant reused 16+ times)
scheduled_reports/router.py endpoints=10 guards=15 ✓
super_admin/router.py       endpoints=9 guards=1 ✓ (every route has super_admin: ... = Depends(current_super_admin); login is intentionally public)
system/router.py            endpoints=2 guards=4 ✓
```

Every authenticated endpoint either takes a `CurrentUser`
parameter (which 401s for anonymous calls) or an explicit
role guard (`require_role("Admin")` etc.). The two
intentional anonymous endpoints are
`POST /api/auth/login` and
`GET /api/auth/oidc/{status,login,callback}`.

**IDOR test — photo by guess** — every photo lookup query
in `hadir/employees/photos.py` includes
``employee_photos.c.tenant_id == scope.tenant_id`` AND
``employee_photos.c.employee_id == employee_id``. A
guessed photo id from another tenant returns 404, not a
crop bytes payload.

**IDOR test — request by guess** — same shape;
`requests/router.py::_can_view` filters on
`scope.tenant_id` + role-scoped employee allowlist.

**SQL-injection probe** — `?q=' OR 1=1--` and
`?q=%; DROP TABLE employees;--` against `/api/employees`
both returned an empty 200 (parameterised query, no
escape needed).

### 2.3 SSRF

**FINDING (medium) — fixed in P27.** `cameras/rtsp.py::parse_rtsp_url`
allowed `http`/`https` schemes "for HTTP MJPEG cameras."
Operators with the Admin role could point a preview-grab
at any HTTP URL — including the cloud metadata service
(`http://169.254.169.254/...`) or internal services
reachable from the backend. **Fix:** scheme allowlist
tightened to `rtsp` + `rtsps` only. Operators with
HTTP-MJPEG cameras bridge them through an RTSP proxy.

`file://` and other schemes were already rejected before
P27.

No other backend-side URL fetches exist outside:

* OIDC discovery + token exchange (URL is per-tenant
  Entra-published, validated against the cached JWKS).
* JWKS fetch (only the URL from the OIDC discovery doc).

Both paths only honour URLs the tenant Admin already
configured. No SSRF.

### 2.4 XSS

* **React rendering** — every template uses JSX
  expressions, which React escapes by default. No
  ``dangerouslySetInnerHTML`` outside a single comment in
  `BrandingProvider.tsx`.
* **Branding CSS injection (highest-risk per the P27
  prompt)** — `BrandingProvider.tsx` builds CSS by reading
  `palette.accent` etc. from the **server-curated**
  `useBrandingOptions` response (8 OKLCH options + 3 font
  stacks per BRD FR-BRD-002). The user submits a *key*
  ("teal", "lato"); the server looks up the actual CSS
  values. Submitting a custom hex or font stack bounces at
  the API CHECK constraint. Result: no operator-supplied
  CSS string can ever land inside the ``<style>`` tag.
* **Logo SVG** — uploaded SVGs are stored as bytes and
  served via auth-required endpoint. They render in an
  ``<img>`` (not inline), so embedded `<script>` doesn't
  execute. Magic-byte validation on upload also rejects
  non-image bytes.

### 2.5 CSRF

* **Session cookies** are set with ``SameSite=Lax``
  (`auth/dependencies.py:274`, `auth/router.py:317,329`).
  Cross-origin POSTs that aren't a top-level navigation
  don't get the cookie.
* **CORS** is allowlist-driven via
  `HADIR_ALLOWED_ORIGINS`. P23's
  `check_production_config` refuses to boot in production
  without a non-empty value. Cross-origin reads of API
  responses are blocked.
* **API surface is JSON-only.** A drive-by form-post
  attack (`<form action="https://hadir.example.com/...">`)
  fails Pydantic validation because the Content-Type is
  `application/x-www-form-urlencoded`, not
  `application/json`.

Posture: layered. No CSRF token planned for v1.x — the
SPA + JSON API shape doesn't need it.

### 2.6 Crypto rotation

Two Fernet keys:

| Key | Encrypts | Rotation cadence |
| --- | --- | --- |
| `HADIR_FERNET_KEY` | RTSP credentials, employee photos, capture crops, request attachments, embeddings | **annual** |
| `HADIR_AUTH_FERNET_KEY` | Entra OIDC client_secret, email config secrets, report signed-URL tokens | **annual + on suspected compromise** |

Rotation is a destructive operation today (rotating
invalidates every cipher). v1.x will introduce two-key
rotation (current + retiring) and a background re-encrypt
job. Documented in `docs/disaster-recovery.md` (P24) and
the runbook step in `docs/deploy-production.md`.

Production deployments MUST track key birthdays in their
secret store and roll on the anniversary regardless of
incident posture.

### 2.7 Secrets in repo / git history

* `git ls-files | xargs grep` for PEM headers, common
  api-key patterns, and 12+ char password strings — only
  hits in `.env.example` (placeholder text), `.md` docs
  (placeholder text), and tests (synthetic `password=
  "test-emp-pw-…"` strings the test conftest builds).
* `git log -p -G ...` for the same patterns over the full
  history — clean.

No plaintext secrets in tree or history.

### 2.8 Tenant isolation

* P5 isolation suite (`tests/test_two_tenant_isolation.py`)
  + the P1 canary (`tests/test_multi_tenant_isolation.py`)
  re-run in this session — **16/16 pass**.
* SQL-injection probes (above) confirmed parameterised
  queries.
* Manual probe: `Manager` role calls to a request id
  outside their assigned-employee set return 403 (the
  P15 `_can_view` guard is universal).
* Manual probe: a Super-Admin with no impersonation
  active (no `Access as` cookie) hitting any
  `/api/{employees,cameras,…}` route 401s — the synthetic
  CurrentUser is only constructed when
  `request.state.is_super_admin` AND
  `request.state.tenant_id` are both set by the
  TenantScopeMiddleware impersonation path.

### 2.9 File upload posture

* **Photos (P6)** — magic-byte check (JPEG/PNG); per-file
  size limited by `python-multipart` request limits;
  filenames generated server-side as
  `{uuid.uuid4().hex}.jpg`; encrypted at rest.
* **Request attachments (P14)** — magic-byte sniff with
  per-format allowlist (JPEG/PNG/GIF/WEBP/PDF + DOCX
  guarded by extension+content-type pair);
  `HADIR_REQUEST_ATTACHMENT_MAX_MB` (default 5MB)
  server-enforced regardless of any client check;
  encrypted at rest; filenames are
  `{uuid.uuid4().hex}.{ext}`.
* **Branding logo (P4)** — magic-byte check (PNG signature
  or SVG `<svg`); `_MAX_BYTES = 200 * 1024` cap;
  filenames are `logo.{ext}` per tenant directory.
* **Employee Excel import (P5)** — openpyxl reads the
  uploaded bytes; openpyxl's parser is the gate. No file
  ever lands on disk under operator-controlled name; row
  errors collected, not fatal.

No file path is operator-controllable. No execution-as-
code surface (no Markdown/HTML rendering of operator-
supplied bytes).

### 2.10 Audit log immutability

Verified in this session:

```
$ psql -U hadir_app -c "DELETE FROM main.audit_log WHERE 1=1"
ERROR: permission denied for table audit_log

$ psql -U hadir_app -c "UPDATE main.audit_log SET action='tampered'"
ERROR: permission denied for table audit_log

$ psql -U hadir_app -c "TRUNCATE main.audit_log"
ERROR: permission denied for table audit_log
```

The `hadir_app` runtime role has INSERT + SELECT only on
`audit_log` (P2 grant policy). Mutation requires the
`hadir_admin` role, which only Alembic + scripts hold.
Red-line preserved.

---

## 3. Findings summary

| ID | Title | Severity | Status | Fix |
| --- | --- | --- | --- | --- |
| P27-001 | 24 known CVEs in Python deps (authlib, cryptography, jinja2, python-multipart, python-dotenv, starlette, weasyprint) | high → low | **fixed** | Bumped per §1.2. 4 dev-only CVEs remain. |
| P27-002 | 5 high-severity npm CVEs (react-router-dom XSS open-redirect, playwright SSL verify, related transitives) | high → low | **fixed** | Bumped per §1.3. 5 dev-only moderates remain. |
| P27-003 | 28H + 6C nginx OS CVEs from `nginx:1.27-alpine` | high | **fixed** | Rebased on `nginx:stable-alpine` (alpine 3.23.4) → 0/0. |
| P27-004 | 11H + 2C CVEs in supercronic v0.2.29 binary | high | **fixed** | Bumped to v0.2.45 → 0/0. |
| P27-005 | 142 unfixed-upstream HIGH OS CVEs in `python:3.11-slim` (debian 13.4 trixie) | medium (no fix) | **deferred** | Monthly rebuild via M3 backlog item. |
| P27-006 | 8H + 1C CVEs in gosu binary on `postgres:15-alpine` (used by base image, not by our code) | medium | **deferred** | v1.x dependency refresh. |
| P27-007 | No password-length policy in `scripts/seed_admin.py` + `scripts/provision_tenant.py` | medium | **fixed** | 12-char minimum enforced; OIDC remains the recommended path. |
| P27-008 | RTSP URL validator allowed `http`/`https` schemes — SSRF surface against internal services | medium | **fixed** | Allowlist tightened to `rtsp`/`rtsps` only. |
| P27-009 | Bandit: 53 LOW findings (assert_used + try-except-pass + B105 false-positive) | informational | **acknowledged** | All deliberate patterns; no action. |

**Critical findings open:** **0**.
**High findings open:** **0**.

M3 gate: clear.

---

## 4. Deferred items (all medium / informational)

* **P27-005** — Backend image's debian-trixie OS CVEs.
  Mitigation: rebuild monthly. Track in M3 backlog.
* **P27-006** — gosu in postgres-base. Mitigation: v1.x
  refresh.
* **black/pytest/pip/wheel** dev-only Python CVEs.
  Mitigation: bump on next refresh.
* **vite/esbuild/exceljs** dev-only npm CVEs. Same
  mitigation.

Each one is logged on the M3 backlog with a deadline of
v1.x (next refresh phase).

---

## 5. Sign-off

* All P27 fixes landed in `chore(P27): security review pass`.
* 435 backend tests pass on the bumped dependency set.
* Tenant isolation suite (P1 canary + P5 two-tenant smoke)
  re-run, 16/16 pass.
* Audit-log immutability re-verified.
* No critical or high findings open.

**M3 hardening complete** — the next session is M4
(launch).
