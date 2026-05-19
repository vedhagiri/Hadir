# Fresh-init API smoke

A one-shot Python script that probes every first-paint API endpoint
and flags any 5xx. Intended to catch the specific class of bug where
an endpoint 500s on a clean database because it assumes seed data
exists (no cameras, no employees, no clips, no attendance records,
no requests).

## When to run

- After provisioning a fresh tenant — before handing it to an
  operator.
- After landing a migration that touches API-side reads — verify the
  fresh-init contract still holds.
- After bumping a runtime dep that surfaces in a 500 (e.g. a
  WeasyPrint / pydyf pin slip, an InsightFace model path change).

Not a replacement for the Playwright pilot smoke
(`frontend/tests/pilot-smoke.spec.ts`) — that exercises the UI flow
end-to-end. This script just guarantees the API layer doesn't 5xx
when the database is empty.

## Setup

The script lives at `backend/scripts/smoke_fresh_init.py`. It logs
in as an existing admin and walks a curated list of GET endpoints.
You need:

1. The stack up: `docker compose up -d` (dev) or
   `docker compose -f docker-compose.prod.yml up -d` (prod).
2. A seeded admin for the tenant under test (see `pilot-plan.md` §P3
   for `seed_admin.py` usage, or the per-tenant Admin from
   `scripts/provision_tenant.py`).

The script uses `requests` (already a runtime dep via FastAPI's
transitive tree, but stdlib-only could be added later if needed).

## Running

### Single-tenant (legacy `main` schema)

```sh
docker compose exec backend python -m scripts.smoke_fresh_init \
    --email admin@pilot.maugood \
    --password 'pick-something-real'
```

### Multi-tenant — name the tenant

```sh
docker compose exec backend python -m scripts.smoke_fresh_init \
    --tenant-slug mts_demo \
    --email demo-admin@maugood.local \
    --password 'pick-something-real'
```

### Against a remote stack

```sh
docker compose exec backend python -m scripts.smoke_fresh_init \
    --base-url https://attendance.example.com \
    --email admin@... --password '...'
```

Or use env vars:

```sh
export MAUGOOD_SMOKE_BASE_URL=http://localhost:8000
export MAUGOOD_SMOKE_EMAIL=admin@pilot.maugood
export MAUGOOD_SMOKE_PASSWORD='pick-something-real'
docker compose exec backend python -m scripts.smoke_fresh_init
```

## Reading the output

Every probe is printed under its page heading with a status tag:

- `OK 200` — endpoint returned 2xx (and not 5xx). Pass.
- ` 4xx` (e.g. `403`, `404`) — client-side; counted but not a fail.
  Use this to verify role gating works.
- `!! 5xx (500)` — server-side failure. **Failed probe** — the
  script will exit non-zero and dump the response body excerpt
  beneath it.
- `NETWORK` — couldn't reach the URL. Server not up?

A passing smoke ends with:

```
  Summary: 28 ok, 0 4xx, 0 5xx, 0 network
  PASS — no 5xx detected on fresh-init APIs.
```

A failing smoke exits 1 and prints `body:` lines you can copy-paste
into `grep` against `backend/logs/app.log` for the corresponding
traceback.

## Adding endpoints

`build_probes()` is data-driven. When you add a new page that fires
an API on first paint, add a `Probe(...)` under the appropriate
section. Keep entries to **GET only** — fresh-init issues are read-
side. Write endpoints have their own per-flow tests.

## What this won't catch

- Cookie-session edge cases that depend on browser state.
- UI rendering bugs from a 4xx body shape mismatch.
- Frontend race conditions (e.g. cache warm-up timing).
- Performance regressions — only the status code matters here.
- Tenant-isolation issues (those are in
  `backend/tests/test_two_tenant_isolation.py`).

For browser-side coverage, extend
`frontend/tests/pilot-smoke.spec.ts` instead.
