# Hadir backend — Claude Code notes

## Status
P1 complete: FastAPI app boots, exposes `GET /api/health`, logs to stdout, dev tooling installed.
P2 will add Alembic + the initial migration into a `main` schema. P3 wires auth.

## Stack
- Python 3.11 (pinned in `pyproject.toml`)
- FastAPI + Uvicorn (`hadir.main:app`)
- SQLAlchemy 2.x Core (`hadir/db.py` — engine only, no tables yet)
- Pydantic v2 + pydantic-settings (`hadir/config.py`, env prefix `HADIR_`)
- Argon2-cffi (installed; used in P3)
- python-dotenv (installed; pydantic-settings reads `.env` directly)
- Dev tooling: ruff, black, mypy (strict), pytest + httpx + pytest-asyncio

## Layout
```
backend/
  pyproject.toml
  Dockerfile
  .env.example
  hadir/
    __init__.py
    main.py        # FastAPI app factory + create_app() + module-level `app`
    config.py      # Settings (HADIR_* env vars)
    db.py          # Engine factory (no models in P1)
  tests/           # P3+ tests live here
```
The full P2+ module map (auth/, employees/, cameras/, capture/, attendance/, etc.)
is documented in `PROJECT_CONTEXT.md` §7 — create those packages as the
relevant pilot prompt arrives, not before.

## Run
- Dev (containerised): `docker compose up backend` from the repo root.
- Dev (host): `pip install -e ".[dev]"` then `uvicorn hadir.main:app --reload`.
- Health: `curl http://localhost:8000/api/health`.
- OpenAPI UI: `http://localhost:8000/api/docs`.

## Conventions (set in P1, enforced going forward)
- Every module starts with a docstring stating its purpose.
- Logging via the stdlib `logging` module to stdout. **Never** log passwords,
  RTSP URLs/credentials, session tokens, or face-embedding bytes.
- Settings loaded via `get_settings()`; do not read `os.environ` directly.
- Tenant plumbing lands in P2 — every tenant-scoped query will filter by
  `tenant_id` even though the pilot is single-tenant (`tenant_id=1`).

## Pilot prompt currently active
P1 — repo scaffold. Next: P2 (Alembic + schema + tenant plumbing). Wait for
the user before starting P2.
