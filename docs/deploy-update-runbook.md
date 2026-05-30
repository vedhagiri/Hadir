# Maugood — Deployment Update Runbook

How to update a **running** Maugood install to a new release **without
losing any database data, configuration, or tenant information**.

The tool is `scripts/deploy-update.sh`. This runbook documents the exact
flow, the safety guarantees, how to dry-run it, how to apply an update,
and how to roll back.

> **Data-safety guarantee.** A normal upgrade never clears or recreates
> the database. The PostgreSQL data lives in a bind-mounted volume
> (`./data/postgres`) that the code update explicitly excludes, and the
> script takes a full `pg_dump` **before** touching anything. Migrations
> are additive and run on backend boot.

---

## 1. What the script does, in order

| Step | Action | Fail behaviour |
|------|--------|----------------|
| 1 | **Validate inputs** — zip exists, install dir exists, `docker-compose.yml` present, `docker`/`python3`/`unzip`/`rsync` available | Stops immediately, nothing changed |
| 2 | **Build upgrade plan** from the zip's `RELEASE-MANIFEST.json`; refuse downgrades / skipped releases (unless `--force-skip-versions`) | Stops, nothing changed |
| 3 | **MANDATORY BACKUP (fail-closed)** — (a) full PostgreSQL dump of **every** schema → `backups/db-<ts>.sql.gz`; (b) config snapshot (`.env`, `backend/.env`, `ops/certs/`, branding, `credentials.txt`) → `backups/<ts>-pre-update.tar.gz` | **Aborts before any file is touched** |
| 4 | **Stop** only the services the plan flagged for rebuild/restart | — |
| 5 | **Extract + rsync** new code over the install dir, excluding every operator-owned path (`.env`, `data/`, `ops/certs/`, `backend/logs/`, `backups/`, branding, `credentials.txt`) | — |
| 6 | **Build** only the services that changed | — |
| 7 | **Start** only the services that changed | — |
| 8 | **Migrations** run automatically on backend boot (Alembic, every tenant schema). Additive — data is never cleared | Backend stays unhealthy → caught in step 9 |
| 9 | **Health verify** `/api/health`. On success → stamp `VERSION`. On failure → `--auto-rollback` restores the DB, or the script stops and prints manual recovery steps | Exits non-zero |

### What is always preserved

The rsync uses `--delete` but **excludes** every operator-owned path, so
the update only replaces application code:

- Database (`./data/postgres`) — tenant data, employees, attendance,
  cameras, policies, audit log
- Uploaded files & reference images (`./data/`)
- Camera RTSP configs (encrypted, in the DB)
- Environment / configuration (`.env`, `backend/.env`, `frontend/.env`)
- TLS certs (`ops/certs/`), in-tree branding (`frontend/src/assets/`)
- `credentials.txt`, `backend/logs/`, `backups/`

---

## 2. Prerequisites

- The target install is running (or at least `postgres` can start).
- You have the release zip produced by `scripts/package-release.sh`
  (contains `RELEASE-MANIFEST.json` and the full code tree).
- Run the script **from the install dir** (or pass `--install-dir`).
- Host needs: `docker`, `python3`, `unzip`, `rsync`. PostgreSQL client
  binaries are **not** needed — `pg_dump`/`psql` run inside the postgres
  container.

---

## 3. Step-by-step

### Step A — Dry run first (changes nothing)

```bash
ZIP=/path/to/maugood-vX.Y.Z.zip
INSTALL=/opt/maugood     # or wherever the install lives

./scripts/deploy-update.sh \
  --zip "${ZIP}" \
  --install-dir "${INSTALL}" \
  --quick-start \
  --dry-run
```

The dry run prints: the from→to version, which services would rebuild /
restart, the backup paths, and the exact `pg_dump` command — without
writing anything.

### Step B — Take a standalone backup (optional, recommended)

You can snapshot the DB + config without updating, any time:

```bash
./scripts/deploy-update.sh --backup-only --install-dir "${INSTALL}" --quick-start
```

Produces `backups/db-<ts>.sql.gz` (verified non-empty) and
`backups/<ts>-pre-update.tar.gz`.

### Step C — Apply the update

This is the command from the spec, with `--auto-rollback` added so a
failed migration restores the DB automatically:

```bash
./scripts/deploy-update.sh \
  --zip "${ZIP}" \
  --install-dir "${INSTALL}" \
  --quick-start \
  --force-skip-versions \
  --auto-rollback \
  --yes
```

What happens:

1. ✅ Backs up the database (`db-<ts>.sql.gz`) — **aborts if this fails**
2. ✅ Snapshots config (`<ts>-pre-update.tar.gz`)
3. ✅ Preserves all tenant data, cameras, employees, attendance,
   reference images, settings (untouched on disk)
4. ✅ Deploys the new application code
5. ✅ Runs migrations on backend boot
6. ✅ Verifies `/api/health`; on failure restores the DB and exits non-zero
7. ❌ Never clears or recreates the database during a normal upgrade

> Full HTTPS stack (nginx + monitoring) instead of quick-start? Drop
> `--quick-start` — the script auto-detects the running compose file.

---

## 4. Flags reference

| Flag | Meaning |
|------|---------|
| `--zip <path>` | Release zip to apply (required unless `--backup-only`) |
| `--install-dir <path>` | Install location (default: the script's parent dir) |
| `--quick-start` | Target the 3-service HTTP stack (`docker-compose.yml`); skip HTTPS auto-detection |
| `--dry-run` | Print every step, write nothing |
| `--backup-only` | Take DB + config backup, then exit |
| `--force-skip-versions` | Allow updating across skipped releases (their data-migration scripts will NOT auto-run) |
| `--auto-rollback` | If health fails post-update, restore the DB from the dump taken in step 3 |
| `--skip-db-backup` | Escape hatch — skip the mandatory `pg_dump`. **Discouraged**; disables `--auto-rollback` |
| `--no-rebuild` | Skip `docker compose build` (code-only changes) |
| `--skip-stop` | Don't stop services before rsync |
| `--yes` / `-y` | No confirmation prompt (for automation) |

---

## 5. Rollback

Every run leaves two recovery artifacts in `backups/`:

- `db-<ts>.sql.gz` — full database dump (all schemas)
- `<ts>-pre-update.tar.gz` — config snapshot

### Automatic (data only)

Pass `--auto-rollback`. If the post-update health check fails, the script
restores the DB from `db-<ts>.sql.gz` automatically and exits non-zero.
This reverts **data + migrations**. The new application **code** stays on
disk — re-extract the previous release zip to fully revert code.

### Manual

```bash
cd "${INSTALL}"

# 1. Restore the database (reverts all data + migrations):
gunzip -c backups/db-<ts>.sql.gz | \
  docker compose -f docker-compose.yml exec -T postgres \
    psql -U maugood -d maugood

# 2. Restore config:
tar -xzf backups/<ts>-pre-update.tar.gz -C ./backups
cp -a backups/<ts>-pre-update/.env ./.env

# 3. Re-extract the PREVIOUS release zip over the install dir, then:
docker compose -f docker-compose.yml up -d --build
```

The dump is taken with `pg_dump --clean --if-exists`, so it drops and
recreates objects cleanly when replayed onto the populated database.

---

## 6. Verifying after an update

```bash
# Containers running:
docker compose -f docker-compose.yml ps

# API health:
curl -s http://localhost:8000/api/health      # quick-start (HTTP)
curl -sk https://localhost/api/health          # full HTTPS stack

# Version stamp:
cat "${INSTALL}/VERSION"
tail "${INSTALL}/.version-history.log"
```

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `error: pg_dump failed — aborting` | Postgres container down or wrong creds. The script tries to start `postgres` and waits 30s. Check `docker compose ps`. Override creds with `MAUGOOD_PG_USER` / `MAUGOOD_PG_DB`. |
| `error: DB dump is suspiciously small` | Dump < 1 KB → partial/empty. Nothing was changed. Investigate the DB before retrying. |
| `WOULD REFUSE: ... skipped a release` | You're jumping versions. Use `--force-skip-versions` (skipped data-migrations won't auto-run). |
| `HEALTH CHECK FAILED` | Most often a failed migration. The script prints the last 30 backend log lines. With `--auto-rollback` the DB is already restored; otherwise follow the printed manual recovery. |
| Health probe times out but app is fine | Probe is 90s. For a slow first boot (model download etc.) re-check `curl /api/health` manually; the code is already deployed. |

---

## 8. Notes for a different DB host / name

The script assumes the postgres service from `docker-compose.yml`
(`user=maugood`, `db=maugood`). Override via env if yours differs:

```bash
MAUGOOD_PG_USER=maugood MAUGOOD_PG_DB=maugood \
  ./scripts/deploy-update.sh --zip "${ZIP}" --install-dir "${INSTALL}" --quick-start --yes
```

If your database is managed entirely outside this compose stack, use
`--skip-db-backup` and take your own dump first — but then `--auto-rollback`
is unavailable.
