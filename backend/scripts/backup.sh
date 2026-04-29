#!/usr/bin/env bash
# Maugood backup — DB + on-disk artifacts (v1.0 P24).
#
# Produces a self-describing backup directory under
# ``${MAUGOOD_BACKUP_ROOT}/${TIMESTAMP}/`` containing:
#
#   db/<schema>.sql.gz      pg_dump per public.tenants schema +
#                            public.sql.gz for the global registry
#                            (mts_staff, super_admin_*, tenants)
#   data/faces.tar.gz       tarballs of /data/{faces,attachments,
#   data/attachments.tar.gz  branding,erp,reports}. Each tarball
#   data/branding.tar.gz     is created only when its source dir
#   data/erp.tar.gz          exists and is non-empty.
#   data/reports.tar.gz
#   manifest.json           DB version, schema list, file list +
#                            sha256 checksum, sizes, timestamps.
#
# After the local snapshot is written + verified the script
# (optionally) ships it to a remote destination
# (``MAUGOOD_BACKUP_S3_URI`` for an S3-compatible bucket) and
# enforces the retention policy on the local copy.
#
# Pilot defaults: 30 daily / 12 weekly / 12 monthly. Override
# via ``MAUGOOD_BACKUP_RETAIN_*`` env vars.
#
# Required env (defaults marked):
#   MAUGOOD_ADMIN_DATABASE_URL  Postgres URL (admin role).
#   MAUGOOD_BACKUP_ROOT         /backup     local root (default).
#   MAUGOOD_DATA_ROOT           /data       on-disk artifact root.
#   MAUGOOD_BACKUP_S3_URI       (optional)  s3://bucket/prefix/.
#   MAUGOOD_BACKUP_RETAIN_DAILY    30
#   MAUGOOD_BACKUP_RETAIN_WEEKLY   12
#   MAUGOOD_BACKUP_RETAIN_MONTHLY  12
#
# Usage:
#   ./backup.sh                # full backup
#   MAUGOOD_BACKUP_DRY_RUN=1 ./backup.sh   # log only, no write
#
# The script is intentionally idempotent and safe to retry —
# every output goes to a timestamped directory the script
# creates fresh on each run. If a previous run died mid-way
# the dangling directory is left for an operator to inspect;
# retention won't sweep partial backups (we tag complete runs
# with a ``_complete`` marker file at the very end).

set -euo pipefail

# ---- helpers ---------------------------------------------------

log() { printf '[backup %s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() { log "FATAL: $*"; exit 2; }

require_bin() {
    command -v "$1" >/dev/null 2>&1 || die "missing required binary: $1"
}

require_env() {
    [ -n "${!1-}" ] || die "missing required env var: $1"
}

# ---- preflight -------------------------------------------------

require_bin pg_dump
require_bin psql
require_bin tar
require_bin gzip
require_bin sha256sum
require_bin jq

require_env MAUGOOD_ADMIN_DATABASE_URL

BACKUP_ROOT="${MAUGOOD_BACKUP_ROOT:-/backup}"
DATA_ROOT="${MAUGOOD_DATA_ROOT:-/data}"
S3_URI="${MAUGOOD_BACKUP_S3_URI:-}"
RETAIN_DAILY="${MAUGOOD_BACKUP_RETAIN_DAILY:-30}"
RETAIN_WEEKLY="${MAUGOOD_BACKUP_RETAIN_WEEKLY:-12}"
RETAIN_MONTHLY="${MAUGOOD_BACKUP_RETAIN_MONTHLY:-12}"
DRY_RUN="${MAUGOOD_BACKUP_DRY_RUN:-0}"

TIMESTAMP="$(date -u +'%Y-%m-%d-%H%M%S')"
TARGET_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

if [ "${DRY_RUN}" = "1" ]; then
    log "DRY RUN — would write to ${TARGET_DIR}"
    log "schemas would be:"
    psql "${MAUGOOD_ADMIN_DATABASE_URL}" -At -c \
        "SELECT 'main' UNION SELECT schema_name FROM public.tenants ORDER BY 1" \
        || die "psql probe failed"
    exit 0
fi

mkdir -p "${TARGET_DIR}/db" "${TARGET_DIR}/data"
log "writing backup to ${TARGET_DIR}"

# ---- DB dump ---------------------------------------------------

DB_VERSION=$(psql "${MAUGOOD_ADMIN_DATABASE_URL}" -At -c 'SHOW server_version' \
    || die "psql could not query server version")
log "postgres server version: ${DB_VERSION}"

# Pull the schema list. ``main`` is the pilot/legacy schema
# (always present); ``public`` carries the global tenant
# registry + super-admin tables; per-tenant schemas live under
# ``public.tenants.schema_name``.
SCHEMAS_JSON=$(psql "${MAUGOOD_ADMIN_DATABASE_URL}" -At -c \
    "WITH s AS (
        SELECT 'public'   AS schema_name, 0 AS ord
        UNION ALL
        SELECT 'main',                 1
        UNION ALL
        SELECT schema_name,            2
        FROM public.tenants
        WHERE schema_name <> 'main'
     )
     SELECT json_agg(schema_name ORDER BY ord, schema_name) FROM s" \
    || die "psql could not enumerate schemas")
log "schemas to dump: ${SCHEMAS_JSON}"

# pg_dump per schema. We dump --schema=NAME to keep restore
# granular (an operator can restore a single tenant without
# touching the rest). ``--no-owner --no-privileges`` strips
# role assignments because the destination cluster will have
# its own ``maugood_app`` / ``maugood_admin`` roles + grants from
# migration 0001.
#
# We deliberately do NOT pass ``--clean --if-exists`` — that
# would emit ``DROP SCHEMA public`` which conflicts with the
# citext extension dependency on a freshly-initdb'd cluster.
# ``restore.sh`` handles drops itself, in reverse dependency
# order, before applying any of these dumps.
for schema in $(printf '%s' "${SCHEMAS_JSON}" | jq -r '.[]'); do
    out="${TARGET_DIR}/db/${schema}.sql.gz"
    log "pg_dump --schema=${schema} -> ${out}"
    pg_dump "${MAUGOOD_ADMIN_DATABASE_URL}" \
        --schema="${schema}" \
        --no-owner \
        | gzip -c > "${out}" \
        || die "pg_dump for ${schema} failed"
done

# ---- on-disk artifacts ----------------------------------------

# Five top-level dirs we expect. Skip empties — operators
# without the corresponding feature in use don't pay the
# tarball cost.
for sub in faces attachments branding erp reports; do
    src="${DATA_ROOT}/${sub}"
    out="${TARGET_DIR}/data/${sub}.tar.gz"
    if [ ! -d "${src}" ]; then
        log "skip ${sub} — ${src} not present"
        continue
    fi
    if [ -z "$(ls -A "${src}" 2>/dev/null)" ]; then
        log "skip ${sub} — ${src} is empty"
        continue
    fi
    log "tar -czf ${out} ${src}"
    # ``-C`` so the archive paths are relative to the data root.
    tar -czf "${out}" -C "${DATA_ROOT}" "${sub}" \
        || die "tar for ${sub} failed"
done

# ---- manifest --------------------------------------------------

# Build the manifest from the actual files on disk (post-dump),
# so checksums match exactly what restore will read back. JSON
# shape is intentionally narrow — restore.sh consumes only the
# fields it needs and tolerates extras.
manifest_path="${TARGET_DIR}/manifest.json"

# files[] = { path, size_bytes, sha256 }
files_json=$(cd "${TARGET_DIR}" && \
    find . -type f -not -name 'manifest.json' -not -name '_complete' \
    | sort \
    | while read -r f; do
        rel="${f#./}"
        size=$(stat -c '%s' "${f}" 2>/dev/null || stat -f '%z' "${f}")
        sha=$(sha256sum "${f}" | awk '{print $1}')
        printf '{"path":"%s","size_bytes":%s,"sha256":"%s"}\n' \
            "${rel}" "${size}" "${sha}"
    done | jq -s '.'
)

jq -n \
    --arg version "1" \
    --arg created_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg timestamp "${TIMESTAMP}" \
    --arg pg_version "${DB_VERSION}" \
    --arg backup_root "${BACKUP_ROOT}" \
    --arg data_root "${DATA_ROOT}" \
    --argjson schemas "${SCHEMAS_JSON}" \
    --argjson files "${files_json}" \
    '{
        manifest_version: $version,
        created_at: $created_at,
        timestamp: $timestamp,
        pg_server_version: $pg_version,
        backup_root: $backup_root,
        data_root: $data_root,
        schemas: $schemas,
        files: $files
    }' > "${manifest_path}" \
    || die "manifest assembly failed"

log "manifest written ($(wc -c < "${manifest_path}") bytes, $(jq '.files|length' "${manifest_path}") files)"

# ---- mark complete --------------------------------------------

# A ``_complete`` marker means retention is allowed to consider
# this run for sweeping. Partial runs (dangling directories
# from a crashed pg_dump) won't get pruned.
touch "${TARGET_DIR}/_complete"

# ---- optional S3 upload ---------------------------------------

if [ -n "${S3_URI}" ]; then
    if ! command -v aws >/dev/null 2>&1; then
        log "WARN: MAUGOOD_BACKUP_S3_URI set but 'aws' CLI not installed; skipping upload"
    else
        dest="${S3_URI%/}/${TIMESTAMP}/"
        log "uploading to ${dest}"
        aws s3 cp --recursive "${TARGET_DIR}/" "${dest}" \
            || log "WARN: S3 upload failed (local copy retained)"
    fi
fi

# ---- retention -------------------------------------------------

# Policy: keep the most recent N daily, the Sunday of the most
# recent N weeks, and the first day of the most recent N months.
# Anything outside those three sets is removed. Only directories
# carrying ``_complete`` are eligible — partial runs survive.
log "applying retention: daily=${RETAIN_DAILY} weekly=${RETAIN_WEEKLY} monthly=${RETAIN_MONTHLY}"

# Collect complete runs sorted newest-first.
mapfile -t COMPLETE < <(
    find "${BACKUP_ROOT}" -mindepth 2 -maxdepth 2 -type f -name '_complete' \
        | sed "s|/_complete$||" \
        | sort -r
)

declare -A KEEP=()
declare -A SEEN_DAY=() SEEN_WEEK=() SEEN_MONTH=()
KEEP_DAILY=0
KEEP_WEEKLY=0
KEEP_MONTHLY=0

for path in "${COMPLETE[@]}"; do
    base=$(basename "${path}")
    # Backup directory format: YYYY-MM-DD-HHMMSS
    day="${base:0:10}"            # YYYY-MM-DD
    # Compute ISO week + month-of-year from the day. Coreutils
    # ``date`` differs slightly between BusyBox and GNU; both
    # the alpine + debian-slim images we ship support these
    # format strings.
    week=$(date -d "${day}" +%G-%V 2>/dev/null || date -j -f '%Y-%m-%d' "${day}" +%G-%V)
    month=$(date -d "${day}" +%Y-%m 2>/dev/null || date -j -f '%Y-%m-%d' "${day}" +%Y-%m)

    keep_this=0
    if [ -z "${SEEN_DAY[$day]:-}" ] && [ "${KEEP_DAILY}" -lt "${RETAIN_DAILY}" ]; then
        SEEN_DAY[$day]=1
        KEEP_DAILY=$((KEEP_DAILY + 1))
        keep_this=1
    fi
    if [ -z "${SEEN_WEEK[$week]:-}" ] && [ "${KEEP_WEEKLY}" -lt "${RETAIN_WEEKLY}" ]; then
        SEEN_WEEK[$week]=1
        KEEP_WEEKLY=$((KEEP_WEEKLY + 1))
        keep_this=1
    fi
    if [ -z "${SEEN_MONTH[$month]:-}" ] && [ "${KEEP_MONTHLY}" -lt "${RETAIN_MONTHLY}" ]; then
        SEEN_MONTH[$month]=1
        KEEP_MONTHLY=$((KEEP_MONTHLY + 1))
        keep_this=1
    fi
    if [ "${keep_this}" = "1" ]; then
        KEEP[$path]=1
    fi
done

for path in "${COMPLETE[@]}"; do
    if [ -z "${KEEP[$path]:-}" ]; then
        log "retention sweep: rm -rf ${path}"
        rm -rf "${path}"
    fi
done

log "backup complete: ${TARGET_DIR}"
