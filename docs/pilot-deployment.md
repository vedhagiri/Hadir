# Maugood — pilot deployment runbook

Short, specific operator guide for standing up the pilot on a fresh
Ubuntu host (or any Docker-capable Linux box). For full background read
`PROJECT_CONTEXT.md` and `pilot-plan.md`; this document assumes you've
already done that.

> **Scope.** This is the **demo** build, not production. HTTPS, OIDC,
> backups, monitoring, and approvals are all deferred per
> PROJECT_CONTEXT §8 — do not promise any of them to the customer.

---

## Prerequisites

- Docker ≥ 24 + Docker Compose v2 plugin
- Internet access on first boot (InsightFace downloads ~250 MB once)
- One reachable IP camera, RTSP credentials in hand
- Admin email + password to seed (pick something the customer's IT
  contact will own)

---

## Required environment variables

The repo ships an `.env.example` at the root and per service. Copy and
edit before first boot:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

| Variable | Purpose | Pilot value |
| --- | --- | --- |
| `MAUGOOD_DATABASE_URL` | App-runtime Postgres URL (`maugood_app` role) | `postgresql+psycopg://maugood_app:maugood_app@postgres:5432/maugood` |
| `MAUGOOD_ADMIN_DATABASE_URL` | Migrations + seed-script URL | `postgresql+psycopg://maugood:maugood@postgres:5432/maugood` |
| `MAUGOOD_APP_DB_PASSWORD` | Set by 0001 migration on the `maugood_app` role | change for shared envs |
| `MAUGOOD_ADMIN_DB_PASSWORD` | Same for `maugood_admin` | change for shared envs |
| `MAUGOOD_SESSION_SECRET` | Reserved (sessions are opaque tokens; not used to sign yet) | random 64-byte URL-safe |
| `MAUGOOD_FERNET_KEY` | Encryption key for face crops, capture crops, embeddings, RTSP URLs | **generate per deployment**: `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `MAUGOOD_TENANT_MODE` | Pilot is `single`; v1.0 SaaS is `multi` | `single` |
| `MAUGOOD_ENV` | `dev` exposes the `/api/_test/*` smoke endpoints; **production must be `production`** (or anything but `dev`) | `production` for Omran handoff |
| `MAUGOOD_SESSION_IDLE_MINUTES` | Sliding session timeout | `60` |
| `MAUGOOD_LOGIN_MAX_ATTEMPTS` | Pilot rate limiter ceiling | `10` |
| `MAUGOOD_LOGIN_RATE_LIMIT_RESET_MINUTES` | Pilot rate limiter reset interval | `10` |
| `MAUGOOD_MATCH_THRESHOLD` | Cosine cutoff (hard); below → unidentified | `0.45` |
| `MAUGOOD_LOCAL_TIMEZONE` | IANA name; UTC→local conversion for shift policy | `Asia/Muscat` |
| `MAUGOOD_ATTENDANCE_RECOMPUTE_MINUTES` | APScheduler cadence for today's recompute | `15` |

> ⚠ `MAUGOOD_FERNET_KEY` is the single key for **all** at-rest encryption
> (face photos, capture crops, RTSP URLs, embeddings). Lose it and every
> stored crop and credential becomes unrecoverable. Back it up to the
> customer's secret manager out of band.

---

## Volumes

| Compose volume | Mount | Purpose | Lifecycle |
| --- | --- | --- | --- |
| `postgres_data` | `/var/lib/postgresql/data` (postgres) | All DB state (employees, attendance, audit log) | persists `down`; reset on `down -v` |
| `faces_data` | `/data` (backend) | Encrypted reference photos + capture crops under `/data/faces/...` | persists `down`; reset on `down -v` |
| `insightface_models` | `/root/.insightface` (backend) | `buffalo_l` model files (download once) | persists `down` |
| `frontend_node_modules` | `/app/node_modules` (frontend) | Linux-built npm cache for the dev server | reset on rebuild — safe to drop |

Back up `postgres_data` + `faces_data` together — they're a matched pair.

---

## First boot

```bash
# from the repo root
docker compose up --build
```

The backend container's entrypoint runs `alembic upgrade head` before
Uvicorn. On a clean DB this creates schema `main`, the
`maugood_admin` + `maugood_app` Postgres roles, all 12 application tables,
the citext extension, and seeds tenant `(1, 'Omran')` plus the four
roles plus three departments (ENG/OPS/ADM) plus the pilot Fixed
shift policy `Default 07:30–15:30`.

Smoke the boot:

```bash
curl http://localhost:8000/api/health
# → {"status":"ok"}
```

---

## Seed the first Admin

```bash
docker compose exec -e MAUGOOD_SEED_PASSWORD='choose-a-strong-password' backend \
  python -m scripts.seed_admin \
    --email admin@omran.example \
    --full-name "Omran Pilot Admin"
```

Re-running is idempotent — the script upserts the user and asserts the
Admin role. The password never appears in logs.

---

## Configure cameras + import employees

1. Open <http://localhost:5173>, sign in as the admin you just seeded.
2. **Cameras** → *Add camera* → name, location, RTSP URL (e.g.
   `rtsp://user:pass@10.0.0.50:8554/stream`). Save.
   - The capture worker for the new camera spawns immediately.
   - Click **Preview** to confirm the camera is reachable.
3. **Employees** → *Import* → drop the customer's `.xlsx` with columns
   `employee_code, full_name, email, department_code`.
4. **Employees** → click an employee → drag-and-drop one or more
   reference photos in the drawer (or use the bulk endpoint with
   `OM0097.jpg` / `OM0097_left.jpg` / etc. naming). Each upload runs
   InsightFace recognition synchronously and the matcher cache reloads
   that employee.

---

## Verify identification

After at least one reference photo per active employee:

1. Walk past a configured camera.
2. **Camera Logs** → your event appears within ~1 s with the right
   `employee_id` and a confidence score.
3. **Daily Attendance** → within 15 minutes (or on an explicit
   recompute) your row carries `in_time` and the right flag set.
4. **Reports** → date range = today → *Generate Excel* → file
   downloads with one row per attendance record.

If a known employee shows up as `Unidentified`, check the threshold:
`MAUGOOD_MATCH_THRESHOLD` is hard. The matcher logs the top-3 scores per
event at `DEBUG`; bump backend log level to see the distribution.

---

## Roll back

Drop the stack but keep data:

```bash
docker compose down
```

Wipe everything (Postgres rows, encrypted crops, InsightFace models,
the lot):

```bash
docker compose down -v
```

Roll a single Alembic revision back (destructive — drops the table):

```bash
docker compose exec backend alembic downgrade -1
```

The migration order is `0001_initial → 0002_employees → 0003_cameras →
0004_capture → 0005_photo_embeddings → 0006_attendance`.

---

## Hard production red lines

- `MAUGOOD_ENV` MUST NOT be `dev` in production. The dev-only test
  endpoints under `/api/_test/*` (used by `frontend/tests/pilot-smoke.spec.ts`)
  are mounted only when `MAUGOOD_ENV=dev` and would let any
  authenticated Admin seed fake detections + bypass the 15-minute
  scheduler. The `create_app` factory checks the env explicitly — do
  not patch that check away.
- `MAUGOOD_FERNET_KEY` MUST be unique per deployment and stored in the
  customer's secret manager.
- The `maugood_app` role must be the runtime DB user. `maugood_admin` is
  for migrations + manual operations only — it bypasses the
  append-only grant on `audit_log`.
- The pilot is HTTP-only on the corporate LAN (PROJECT_CONTEXT §3).
  Wrap nginx + a real cert before exposing anything beyond the LAN.
