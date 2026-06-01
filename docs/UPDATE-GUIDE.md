# Maugood — Update Guide (Simple)

A step-by-step guide to update a running Maugood install to a new version.
**Your data is never deleted** — the update only replaces application code;
the database, uploaded files, cameras, employees, and settings all stay.

> Detailed reference: `docs/deploy-update-runbook.md`. This file is the
> short version you follow each time.

---

## Before you start — set two variables

Point these at your install folder and the new release zip:

```bash
INSTALL="/home/USER/Maugood/maugood-v1.1.14"     # the FOLDER currently running
ZIP="/home/USER/Maugood/maugood-v1.1.16.zip"     # the NEW version zip
```

> Tip: the folder name is just a label. The real running version is in the
> `VERSION` file inside it — don't worry if the folder says `v1.1.14` while
> it actually runs something newer.

---

## Step 1 — Check the inputs exist

```bash
[[ -f "${ZIP}" ]]                        && echo "zip OK"     || echo "zip MISSING"
[[ -d "${INSTALL}" ]]                    && echo "install OK" || echo "install MISSING"
[[ -f "${INSTALL}/docker-compose.yml" ]] && echo "compose OK" || echo "compose MISSING"
```

All three must say **OK**. (Use `docker-compose.yml` — that's the standard
HTTP stack. Only check `docker-compose-https-local.yaml` if you actually run
the HTTPS + nginx stack.)

---

## Step 2 — Apply the update

The script does **everything**: backs up the database, backs up your config,
swaps in the new code, runs database migrations, and checks health.

```bash
cd "${INSTALL}"

./scripts/deploy-update.sh \
  --zip "${ZIP}" \
  --install-dir "${INSTALL}" \
  --quick-start \
  --force-skip-versions \
  --auto-rollback \
  --yes
```

What each flag means:

| Flag | Meaning |
|------|---------|
| `--quick-start` | Standard HTTP stack (postgres + backend + frontend) |
| `--force-skip-versions` | Allow jumping versions (e.g. 1.1.14 → 1.1.16) |
| `--auto-rollback` | If something breaks, restore the database automatically |
| `--yes` | Don't stop to ask "are you sure?" |

> **Want to preview first without changing anything?** Add `--dry-run`.
> It prints every step but writes nothing. Remove it to do the real update.
> **`--dry-run` = nothing happens. This is the #1 "why didn't it update?"
> reason.**

You'll see it: take the DB backup → stop services → copy new code → rebuild →
start → run migrations → `✓ backend healthy` → `✓ Update applied`.

---

## Step 3 — Confirm it worked

```bash
cd "${INSTALL}"

# 1. Version updated?
cat VERSION                                                   # e.g. 1.1.16

# 2. Database migrations applied? (should end in "(head)")
docker compose -f docker-compose.yml exec -T backend alembic current

# 3. Backend healthy?
curl -s http://localhost:8000/api/health                      # {"status":"ok"}

# 4. Everything running?
docker compose -f docker-compose.yml ps
```

> **Ports:** the defaults are `8000` (backend) and `5173` (frontend). If your
> install uses different ports (e.g. `8001` / `5174`), use those instead —
> check the `ports:` lines or `docker compose ps`.

✅ If `VERSION` shows the new number, `alembic current` ends in `(head)`, and
health returns `{"status":"ok"}` — **the update is done.** Open the app in the
browser and confirm your employees, cameras, and attendance are still there
(they will be — `data/` is never touched).

---

## Step 4 — If the browser shows "Failed to resolve import …"

This happens when a new version adds a frontend library. The dev server keeps
old packages in a cached volume. Fix:

```bash
cd "${INSTALL}"
docker compose -f docker-compose.yml exec frontend npm install
docker compose -f docker-compose.yml restart frontend
```

Then hard-reload the browser (`Ctrl + Shift + R`).

> Newer versions of `deploy-update.sh` do this automatically after a frontend
> change — you only need this if you're updating from an older script.

---

## Step 5 — If you see "stored RTSP URL could not be decrypted" (HTTP 500)

This is an **encryption-key mismatch**, not a bug. `MAUGOOD_FERNET_KEY`
(in `.env`) encrypts camera URLs, employee photos, and attachments. If the
backend runs a *different* key than the one your data was encrypted with,
every decrypt fails with a 500.

> 🛡️ The updated `deploy-update.sh` now **guards against this**: it refuses
> to update if `MAUGOOD_FERNET_KEY` is missing / the dev default, and warns
> if the key changed after the update. So a clean run shouldn't hit this.

If you do hit it, find which key is wrong:

```bash
cd "${INSTALL}"
docker compose -f docker-compose.yml exec -T backend printenv MAUGOOD_FERNET_KEY   # what the backend uses now
grep MAUGOOD_FERNET_KEY .env                                                        # what .env says
# the original key (before the update) is in the pre-update backup:
tar -xzf backups/<timestamp>-pre-update.tar.gz -C /tmp
grep MAUGOOD_FERNET_KEY /tmp/*-pre-update/.env
```

Then restore the **original** key into `.env` and recreate the backend
(`restart` is not enough — it won't re-read `.env`):

```bash
nano .env        # set MAUGOOD_FERNET_KEY back to the original value
docker compose -f docker-compose.yml up -d --force-recreate backend
```

> ⚠️ **Never generate a new Fernet key on an existing install** — it
> permanently locks all already-encrypted cameras, photos, and attachments.
> Only the *original* key can decrypt them.

---

## (Optional) Take a manual database backup first

The script already backs up the DB automatically. But if you want an extra
copy before you even start:

```bash
cd "${INSTALL}"
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)
DB_PASS=$(grep '^MAUGOOD_ADMIN_DB_PASSWORD=' .env | cut -d= -f2- | tr -d '"')

docker compose -f docker-compose.yml exec -T \
  -e PGPASSWORD="${DB_PASS}" \
  postgres pg_dump -h localhost -U maugood -d maugood \
  --clean --if-exists --no-owner --no-privileges \
| gzip > "backups/db-${TS}.sql.gz"

ls -lh backups/
```

> ⚠️ Use the **same** compose file your stack actually runs
> (`docker-compose.yml` here). Pointing at a compose file whose postgres
> isn't running produces an empty/broken backup file.

---

## If something goes wrong — Rollback

Every run leaves two safety files in `backups/`:
- `db-<timestamp>.sql.gz` — full database backup
- `<timestamp>-pre-update.tar.gz` — your config (.env, certs, branding)

**With `--auto-rollback`** (recommended): if the update fails its health
check, the database is restored automatically. The new code stays on disk —
re-extract the previous zip to fully revert code.

**Manual rollback:**

```bash
cd "${INSTALL}"

# 1. Restore the database:
gunzip -c backups/db-<timestamp>.sql.gz | \
  docker compose -f docker-compose.yml exec -T postgres psql -U maugood -d maugood

# 2. Restore config:
tar -xzf backups/<timestamp>-pre-update.tar.gz -C ./backups
cp -a backups/<timestamp>-pre-update/.env ./.env

# 3. Re-extract the PREVIOUS version's zip over the folder, then:
docker compose -f docker-compose.yml up -d --build
```

---

## Quick reference — the whole thing

```bash
# set paths
INSTALL="/home/USER/Maugood/maugood-vX.Y.Z"
ZIP="/home/USER/Maugood/maugood-vNEW.zip"

# update
cd "${INSTALL}"
./scripts/deploy-update.sh --zip "${ZIP}" --install-dir "${INSTALL}" \
  --quick-start --force-skip-versions --auto-rollback --yes

# verify
cat VERSION
docker compose -f docker-compose.yml exec -T backend alembic current
curl -s http://localhost:8000/api/health
docker compose -f docker-compose.yml ps

# if "Failed to resolve import" in browser:
docker compose -f docker-compose.yml exec frontend npm install
docker compose -f docker-compose.yml restart frontend
```

---

### Real example (what actually ran)

`v1.1.14 → v1.1.16`, 34 migrations, rebuilt backend + frontend, finished with
`✓ backend healthy`. `VERSION` → `1.1.16`, `alembic current` →
`0070_employee_photo_content_hash (head)`. One frontend
`npm install` was needed afterward for the newly-added `react-icons` package.
