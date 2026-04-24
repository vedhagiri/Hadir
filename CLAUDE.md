# Hadir — Claude Code project notes

> **For new sessions:** read this file first, then `PROJECT_CONTEXT.md`
> (history + decisions), then `pilot-plan.md` (the active phased plan).
> Never start coding without confirming which prompt is active.

## What this is
Hadir is a camera-based employee attendance platform built by Muscat Tech
Solutions for Omran (Oman). IP cameras detect employees by face, the system
computes attendance against shift policies, and reports are delivered out.
The pilot is a 5-day single-tenant demo on a corporate LAN; v1.0 is the
multi-tenant SaaS-capable product 8–10 weeks after pilot signoff.

## Status
**Pilot prompt currently active: P1 — Repo scaffold and skeleton apps (DONE).**
Next: P2 — Database schema, migrations, multi-tenant plumbing. Wait for the
user before starting it.

What P1 built:
- Monorepo layout per PROJECT_CONTEXT §7
- Backend: FastAPI app with `GET /api/health`, stdout logging, Pydantic v2
  settings, SQLAlchemy 2.x engine factory, Argon2-cffi installed,
  ruff/black/mypy/pytest dev deps
- Frontend: Vite + React 18 + TS strict, React Router / TanStack Query /
  Zustand / RHF / Zod installed, single page rendering "Hadir" using the
  design system CSS, all four design CSS files imported in order
- Design archive: `styles*.css` (4 files) verbatim into `frontend/src/styles/`,
  `icons/shell/ui/pages/dashboards/employee/data.jsx` verbatim into
  `frontend/src/design/` as read-only reference
- Docker Compose: backend, frontend (Vite dev), Postgres 15 with named
  volumes for `postgres_data` and `frontend_node_modules`
- `.env.example` at repo root and per service; `.gitignore` covers Python,
  Node, env files, runtime data dirs

## Tech stack (summary)
- **Backend:** Python 3.11, FastAPI, Uvicorn, SQLAlchemy 2.x Core, Pydantic
  v2, Argon2-cffi, python-dotenv. Postgres 15.
- **Frontend:** Vite, React 18, TypeScript strict mode, React Router v6,
  TanStack Query, Zustand, React Hook Form, Zod. Plain CSS (no Tailwind, no
  CSS-in-JS).
- **Infra:** Docker Compose for dev. Single-host Ubuntu deployment for
  pilot. See PROJECT_CONTEXT §5 for the full stack with rationale.

## Directory map
```
hadir/
  backend/                  # Python service — see backend/CLAUDE.md
    pyproject.toml
    Dockerfile
    .env.example
    hadir/
      __init__.py
      main.py               # FastAPI app + create_app()
      config.py             # Pydantic Settings (HADIR_* env vars)
      db.py                 # SQLAlchemy engine factory
    tests/                  # pytest suite (P3+)
  frontend/                 # Vite + React app — see frontend/CLAUDE.md
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    Dockerfile
    .env.example
    src/
      main.tsx              # entry; imports CSS + mounts <App/>
      App.tsx               # P1 placeholder ("Hadir")
      styles/               # design CSS, copied verbatim
      design/               # design JSX reference, read-only
  design-reference/         # unpacked design archive (input source)
  docker-compose.yml
  .env.example              # repo-root env template
  .gitignore
  CLAUDE.md                 # this file
  PROJECT_CONTEXT.md        # decisions log
  pilot-plan.md             # the 5-day pilot plan
  Hadir_v1.0_BRD.docx       # business requirements
```

## How to run
1. **First run:** copy env templates.
   ```sh
   cp .env.example .env
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   # Generate a Fernet key for HADIR_FERNET_KEY:
   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```
2. **Bring up the stack:**
   ```sh
   docker compose up --build
   ```
3. **Verify:**
   - Backend health: `curl http://localhost:8000/api/health` → `{"status":"ok"}`
   - Frontend: open `http://localhost:5173` → renders "Hadir" on the
     warm-neutral background using the display serif
   - Postgres: reachable on `localhost:5432` as `hadir/hadir/hadir`
4. **Stop:** `docker compose down`. Add `-v` to also drop the postgres
   volume (do this only when you want a clean DB).

## Red lines (PROJECT_CONTEXT §12 + pilot-plan §"Red lines")
- Design files are **copied verbatim** — never reformat, "fix", or convert
  `frontend/src/styles/*.css` or `frontend/src/design/*.jsx`.
- **No Tailwind, no CSS-in-JS, no component library.** Style with plain CSS
  via the design system.
- **No extra dependencies** beyond what each pilot prompt names.
- Tenant plumbing from day 1 (added in P2): every tenant-scoped table has
  `tenant_id`; every query filters by it.
- RTSP credentials encrypted with Fernet; passwords never logged; audit log
  is append-only at the DB grant level (P2).
- No scope creep from v1.0 features into the pilot — see PROJECT_CONTEXT §8
  for the deferred list.
