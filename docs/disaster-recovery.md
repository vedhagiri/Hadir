# Maugood — disaster recovery policy

> **Audience:** Omran IT operators + MTS engineers on call.
> **Cadence:** quarterly DR rehearsals. See `docs/dr-rehearsal.md`
> for the running log.

This document states Maugood's disaster-recovery objectives, the
mechanism that meets them, and the future work that will
tighten them.

---

## Targets (pilot defaults)

| Objective                        | Target            | Mechanism                                                        |
| -------------------------------- | ----------------- | ---------------------------------------------------------------- |
| **RTO** — recovery time          | **4 hours**       | Restore from the most recent nightly backup; bring app online.   |
| **RPO** — data loss              | **24 hours**      | Daily backups at 02:00 Asia/Muscat (BRD-required).               |
| **Data integrity**               | sha256 per file   | Manifest in every backup; `restore.sh` aborts on any mismatch.   |
| **Audit-log durability**         | append-only       | DB grants reject UPDATE/DELETE on `audit_log` (see P2 / migrations). |

The 4-hour RTO is comfortably above the worst-case observed in
rehearsal (~13 seconds for a 560 KB pilot dataset; production
will scale roughly linearly with on-disk size). The 24-hour RPO
is the BRD-mandated upper bound; any improvement is operator
upside.

---

## Backup mechanism (P24)

* **Cron**: `backend/scripts/backup.sh` runs at 02:00
  Asia/Muscat by default, fired by supercronic inside the
  `backup` service in `docker-compose.prod.yml`. Override the
  cadence via the entry in `ops/backup/crontab`.
* **What's captured**:
  * `pg_dump --schema=<NAME>` per schema in the manifest:
    `public` (global registry + super-admin), `main` (legacy /
    pilot tenant), and every per-tenant schema in
    `public.tenants`. Each dump is gzip'd.
  * tarballs of `/data/{faces,attachments,branding,erp,reports}`
    (skipped when empty). Faces + attachments are encrypted at
    rest; the tarball preserves the ciphertext as-is.
  * a `manifest.json` listing every file with its sha256,
    size, and the source's `pg_server_version`.
* **Where it lands**:
  * **Local**: `${MAUGOOD_BACKUP_ROOT:-/backup}` on the host
    (mounted into the backup container). Default is the
    `backup_storage` named volume; operators on a NAS-backed
    host bind-mount the NAS path instead via
    `MAUGOOD_BACKUP_DIR=/mnt/nas/maugood`.
  * **Off-site (optional)**: `MAUGOOD_BACKUP_S3_URI=s3://bucket/prefix/`
    triggers an `aws s3 cp --recursive` once the local copy is
    written and verified. Requires `INCLUDE_AWS_CLI=1` at
    image-build time (off by default — keeps the image small).
* **Retention** (configurable, defaults from BRD):
  * `MAUGOOD_BACKUP_RETAIN_DAILY` — last 30 days.
  * `MAUGOOD_BACKUP_RETAIN_WEEKLY` — last 12 weeks (most recent
    Sunday in each).
  * `MAUGOOD_BACKUP_RETAIN_MONTHLY` — last 12 months (first day
    in each).
* **Partial-run safety**: each backup is marked complete with
  a `_complete` marker file at the very end. Retention only
  considers directories carrying the marker — a crashed run
  is left for an operator to inspect rather than swept away.

### Per-tenant restore

`pg_dump` runs **per schema** so an operator can restore a
single tenant without touching the rest. The shape of
`restore.sh` doesn't surface a `--only-tenant` flag yet (P25
hardening territory) but the manifest is self-describing —
extracting one schema's `.sql.gz` and applying it manually is a
one-liner.

---

## Restore mechanism

`backend/scripts/restore.sh --backup-manifest <path>` does the
work. Red-line behaviour:

1. **Checksum gate**: every file referenced by the manifest is
   sha256'd. A single mismatch aborts the run with a non-zero
   exit before any destructive SQL is issued.
2. **Blast-radius probe**: if the target cluster is
   non-empty (`public.tenants` has rows OR any non-system
   schema exists), the script demands an explicit
   confirmation:
   * In production (`MAUGOOD_ENV=production`): the operator must
     pass `--yes-i-have-a-backup-of-the-target` after taking a
     confirmed backup of the *target*. The flag is not a
     shortcut — it's a checkpoint that the operator has done
     the work to make this destruction reversible.
   * In any environment with `--yes-i-have-a-backup-of-the-target`
     unset: the script asks for a typed `RESTORE` (case-
     sensitive, on `/dev/tty` so a script can't bypass it).
3. **Drop in reverse dependency order**: per-tenant schemas
   first (CASCADE), then `main`, then the Maugood tables on
   `public` (the schema itself stays, citext extension lives
   there).
4. **Restore each schema's dump in forward dependency order**:
   public, main, then every per-tenant schema alphabetically.
5. **Restore on-disk artifacts**: `/data/{faces,attachments,
   branding,erp,reports}` from their tarballs. Each subtree
   is wiped before extract so a restored tenant doesn't carry
   leftovers from the host.
6. **Probe + report**: tenant count + active main user count
   logged for an at-a-glance sanity check.

### Operator runbook (incident playbook)

Assumes the target is the production single-host stack.
Detailed compose commands are in `docs/deploy-production.md`.

```sh
# 1. Stop the user-facing surfaces. nginx in particular —
#    you don't want operators logging in mid-restore.
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    stop nginx backend

# 2. Run the restore. The backup container has pg_dump,
#    sha256sum, and the script bind-mounted in.
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    run --rm --entrypoint /app/scripts/restore.sh backup \
        --backup-manifest /backup/<TIMESTAMP>/manifest.json
# Type RESTORE (uppercase) at the prompt. The script logs
# every step; if it errors before issuing destructive SQL,
# nothing on disk has changed.

# 3. Bring the app back online.
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    start backend nginx

# 4. Smoke-check.
curl -k https://${MAUGOOD_PUBLIC_HOSTNAME}/api/health   # 200
# Log in via the UI; verify the bell, recent attendance,
# and at least one report endpoint return restored data.
```

---

## Future work (v1.x)

This section is intentionally a roadmap. Don't quote it as
delivered behaviour.

### Continuous archiving (wal-g or pgBackRest)

Daily backups give a 24-hour worst-case RPO. Postgres'
write-ahead log makes a sub-minute RPO achievable: stream WAL
segments to S3 (or a NAS) as they close, and a restore can
fast-forward from the most recent base backup to within
seconds of the failure.

**Tooling options**:

* **wal-g**: streams WAL + base backups to S3-compatible
  storage; well-known, scriptable. The natural fit for an
  operator-managed S3 bucket.
* **pgBackRest**: more features (delta restores, manifest
  validation, parallel transfer); heavier ops surface.
  Probably overkill for a single-host pilot but a comfortable
  fit if Maugood grows to a multi-node cluster.

**What lands in the v1.x phase that ships this**:

* New `wal-g` (or `pgBackRest`) sidecar in
  `docker-compose.prod.yml`.
* Postgres config changes (`archive_mode=on`, `archive_command`,
  `wal_level=replica`).
* RTO/RPO targets in this document tightened to **RTO 1 hour /
  RPO 5 minutes**.
* `restore.sh` gains a `--target-time '2026-07-15 14:32:00 UTC'`
  flag that drives PITR through the archived WAL.
* The DR rehearsal log records a PITR drill alongside the
  full-restore drill.

### Hot standby (PG streaming replication)

Independent of WAL archiving, a read-only replica on a separate
host shrinks RTO to "promote the replica" — typically under
60 seconds. This is post-pilot work; the BRD doesn't require
it for v1.0.

### Encryption-key escrow

`MAUGOOD_FERNET_KEY` and `MAUGOOD_AUTH_FERNET_KEY` are operator-
generated and (per `docs/deploy-production.md`)
**non-recoverable** — losing them invalidates every encrypted
photo, every encrypted RTSP credential, every encrypted email
secret, every encrypted attachment. The BRD permits this for
pilot; v1.x should put both keys in a managed secret store
(Vault, AWS Secrets Manager, Azure Key Vault) with audited
rotation and offline-attested escrow copies.

### Off-site copy verification

Local backups protect against accidents and bit-rot but not
against site loss. The optional S3 upload covers that — but
once it's on, an operator should:

1. Run a monthly `restore-verify.sh` that pulls the most recent
   off-site copy onto a throwaway host and runs the same
   checksum verification + a test login. Same shape as the
   quarterly DR rehearsal, half the scope.
2. Keep the S3 bucket's lifecycle rules in version control so
   "the bucket got policy-changed and our 90-day-old backups
   silently aged out" can't happen.

---

## See also

* `docs/dr-rehearsal.md` — running log of every rehearsal we've
  done. Append-only.
* `docs/deploy-production.md` — production runbook including
  backup setup at deploy time.
* `backend/scripts/backup.sh` / `backend/scripts/restore.sh` —
  the scripts themselves; comments at the top of each file
  document every env var they accept.
* `backend/CLAUDE.md` "Per-schema migration model" — explains
  how the per-tenant schema layout interacts with backups and
  why pg_dump per schema is the right granularity.
