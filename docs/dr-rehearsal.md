# Maugood — DR rehearsal log

This file is the durable record of every disaster-recovery
rehearsal we run. Each entry below documents one full
**backup → restore on a throwaway host → verify** cycle.
Append-only — never edit a past entry.

The targets these rehearsals are measured against live in
`docs/disaster-recovery.md` (RTO 4 hours / RPO 24 hours for the
pilot defaults).

---

## Rehearsal 2026-04-25 — initial cycle

| Field                  | Value                                              |
| ---------------------- | -------------------------------------------------- |
| Date (UTC)             | 2026-04-25 19:30 — 19:38                            |
| Operator               | Suresh (MTS) via Claude Code                        |
| Source stack           | local docker compose (dev), `tenant_mode=single`   |
| Target stack           | fresh docker compose project `-p maugooddr`          |
| Backup script          | `backend/scripts/backup.sh`                         |
| Restore script         | `backend/scripts/restore.sh`                        |
| Backup version         | manifest_version=1                                  |

### Source data shape

| Schema          | Rows of interest                              |
| --------------- | --------------------------------------------- |
| `public`        | 3 tenants (Omran + tenant_demo + tenant_omran)|
| `main`          | 7 active users; 614 audit rows                |
| `tenant_demo`   | 7 users                                        |
| `tenant_omran`  | 10 users                                       |
| `/data/faces`   | encrypted reference photos (650 B tarball)     |
| `/data/attachments` | request attachments (3.6 KB tarball)        |
| `/data/reports` | generated XLSX/PDF (480 KB tarball)            |
| `/data/branding` | empty — skipped                                |
| `/data/erp`     | empty — skipped                                |

### Backup

```
$ docker run --rm \
    --network maugood_default \
    --entrypoint /app/scripts/backup.sh \
    -e MAUGOOD_ADMIN_DATABASE_URL='postgresql://maugood:maugood@postgres:5432/maugood' \
    -v maugood_faces_data:/data:ro \
    -v maugood_backup_dr:/backup \
    -v "$PWD/backend/scripts:/app/scripts:ro" \
    maugood-backup:latest

[backup ...] schemas to dump: ["public", "main", "tenant_demo", "tenant_omran"]
[backup ...] manifest written (1433 bytes, 7 files)
[backup ...] backup complete: /backup/2026-04-25-193647
```

| Metric            | Value                                          |
| ----------------- | ---------------------------------------------- |
| Backup wall-clock | **1 second**                                   |
| On-disk size      | **~560 KB total** (db: 56 KB, data: 488 KB)    |
| Files in manifest | 7 (4 schema dumps + 3 data tarballs)           |
| Checksums         | sha256 per file, all written to manifest.json  |

### Restore on the throwaway target

```
$ docker compose --env-file /tmp/p24-dr.env -p maugooddr up -d postgres backend
   ... (initial migration runs, 1 seeded tenant exists)

$ docker compose -p maugooddr stop backend           # operator step

$ docker run --rm \
    --network maugooddr_default \
    --entrypoint /app/scripts/restore.sh \
    -e MAUGOOD_ADMIN_DATABASE_URL='postgresql://maugood:maugood@postgres:5432/maugood' \
    -v maugood_backup_dr:/backup:ro \
    -v maugooddr_faces_data:/data \
    -v "$PWD/backend/scripts:/app/scripts:ro" \
    maugood-backup:latest \
        --backup-manifest /backup/2026-04-25-193647/manifest.json \
        --yes-i-have-a-backup-of-the-target

[restore ...] verifying checksums...
[restore ...] checksum verification ok (all 7 files)
[restore ...] target has 1 tenant rows
[restore ...] target has non-system schemas: main
[restore ...] WARNING: target cluster is NOT empty.
[restore ...] --yes-i-have-a-backup-of-the-target flag set; skipping typed confirmation
[restore ...] dropping schemas (reverse dependency order)...
[restore ...] DROP SCHEMA tenant_omran CASCADE
[restore ...] DROP SCHEMA tenant_demo CASCADE
[restore ...] DROP SCHEMA main CASCADE
[restore ...] drop public.* (Maugood tables only, not the schema)
[restore ...] restoring schema=public ... main ... tenant_demo ... tenant_omran
[restore ...] restoring faces / attachments / reports
[restore ...] restored tenants: 3
[restore ...] restored active users in main: 7
[restore ...] restore complete

$ docker compose --env-file /tmp/p24-dr.env -p maugooddr start backend
```

| Phase                     | Wall-clock |
| ------------------------- | ---------- |
| Checksum verification     | < 1 s      |
| DB drop + restore (4 schemas) | 1 s    |
| Data tarball extract (3 files) | < 1 s |
| Backend cold-boot         | 11 s       |
| **Total restore**         | **~13 s**  |

### Verification

Logged into the restored backend over the throwaway target's HTTP
port:

```
$ curl -c $C -X POST http://localhost:8000/api/auth/login \
    -d '{"email":"admin@pilot.maugood","password":"admin123"}'
{"id":2,"email":"admin@pilot.maugood","active_role":"Admin", ...}

$ curl -b $C http://localhost:8000/api/auth/me
{ ..., "preferred_theme": "dark", "preferred_density": "compact" }
```

The user-level preferences (P22) survived the cycle — they're
stored on `users.preferred_theme` / `users.preferred_density`
and round-tripped through pg_dump / restore intact.

DB-level verification matched the source row counts exactly:

| Schema                | Source | Restored |
| --------------------- | ------ | -------- |
| `public.tenants`      | 3      | 3        |
| `main.users`          | 7      | 7        |
| `main.audit_log`      | 614    | 615 *    |
| `tenant_demo.users`   | 7      | 7        |
| `tenant_omran.users`  | 10     | 10       |

\* The +1 on audit_log reflects the login event written by the
verification step itself; pre-login the count was identical to
the source.

### Hiccups encountered (and what shipped to fix them)

1. **`pg_dump --clean --if-exists` conflicted with the citext
   extension.** First restore attempt failed with
   ``cannot drop schema public because other objects depend on
   it`` because the dump's `DROP SCHEMA public CASCADE` would
   take citext with it. **Fix:** drop `--clean --if-exists`
   from the backup invocation; `restore.sh` now handles all
   drops itself in reverse dependency order.
2. **Cross-schema FK constraints blocked per-schema drops.**
   Per-tenant tables FK to `public.tenants(id)`, so dropping
   `public` last failed with "constraint X depends on this
   index". **Fix:** `restore.sh` drops every schema in the
   manifest **upfront**, in reverse dependency order
   (per-tenant first, then `main`, then Maugood tables on
   `public`), before applying any of the dump files.
3. **`pg_dump --no-privileges` stripped the `maugood_app`
   grants.** The backend's runtime role couldn't see the
   restored tables ("permission denied for schema main").
   **Fix:** dropped `--no-privileges` from `pg_dump`; grants
   round-trip with the dumps. `--no-owner` is kept so the
   destination cluster doesn't try to ALTER OWNER TO a role
   that doesn't exist.

All three fixes landed in the same commit as this rehearsal
log; the next rehearsal should hit the happy path on the first
try.

### Outcomes vs. targets

| Target              | Goal     | Actual              | Verdict |
| ------------------- | -------- | ------------------- | ------- |
| RTO (recovery time) | 4 hours  | **~13 seconds**     | ✓ pass  |
| RPO (data loss)     | 24 hours | 0 (backup just taken) | ✓ pass |
| Data fidelity       | 100 %    | row counts match    | ✓ pass  |

### Rehearsal teardown

```
$ docker compose -p maugooddr down -v   # nuke the throwaway target
$ docker volume rm maugood_backup_dr     # nuke the backup volume
$ docker compose up -d                 # restore the dev stack
```

The dev stack on `:5173` / `:8000` was untouched after rehearsal
teardown.

---

## Schedule for the next rehearsal

The DR rehearsal cadence per BRD §"Backups" is **quarterly**.
The next entry below is due **2026-07-25** (90 days from this
one). At that point:

* Use a backup that's 24 hours old (not freshly taken) to
  exercise the realistic RPO.
* Have a second operator drive the restore steps from the
  runbook, not from this log — that's how we'll find the
  tribal knowledge that didn't make it into
  `docs/disaster-recovery.md`.
* Time the typed-`RESTORE` prompt path explicitly, not just
  the `--yes-i-have-a-backup-of-the-target` shortcut.
