#!/usr/bin/env bash
# Hadir restore — pair with ``backup.sh`` (v1.0 P24).
#
# Reads a manifest produced by ``backup.sh``, validates every
# referenced file's sha256 checksum, and (after a typed
# operator confirmation when the destination cluster looks
# populated) restores the database + on-disk artifacts.
#
# Usage:
#   restore.sh --backup-manifest <path/to/manifest.json>
#   restore.sh --backup-manifest <path> --skip-data
#   restore.sh --backup-manifest <path> --yes-i-have-a-backup-of-the-target
#
# Required env (defaults marked):
#   HADIR_ADMIN_DATABASE_URL   Postgres URL (admin role).
#   HADIR_DATA_ROOT            /data (default).
#
# Red lines:
#   * Refuses to run against a non-empty target cluster
#     (``public.tenants`` has > 0 rows OR any per-tenant
#     schema exists) without a typed ``RESTORE`` confirmation.
#     The flag ``--yes-i-have-a-backup-of-the-target`` skips
#     the typed prompt for non-interactive recovery rehearsals
#     but still logs the blast radius.
#   * Verifies every checksum in the manifest. A single
#     mismatch aborts the run with a non-zero exit before any
#     destructive SQL is issued.
#   * Refuses to run when ``HADIR_ENV=production`` unless the
#     operator passes ``--yes-i-have-a-backup-of-the-target``.

set -euo pipefail

# ---- helpers ---------------------------------------------------

log() { printf '[restore %s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die() { log "FATAL: $*"; exit 2; }

require_bin() {
    command -v "$1" >/dev/null 2>&1 || die "missing required binary: $1"
}

require_env() {
    [ -n "${!1-}" ] || die "missing required env var: $1"
}

# ---- args ------------------------------------------------------

MANIFEST=""
SKIP_DATA=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --backup-manifest)
            MANIFEST="$2"
            shift 2
            ;;
        --skip-data)
            SKIP_DATA=1
            shift
            ;;
        --yes-i-have-a-backup-of-the-target)
            ASSUME_YES=1
            shift
            ;;
        -h|--help)
            sed -n '1,40p' "$0"
            exit 0
            ;;
        *)
            die "unknown arg: $1"
            ;;
    esac
done

[ -n "${MANIFEST}" ] || die "missing --backup-manifest <path>"
[ -f "${MANIFEST}" ] || die "manifest not found: ${MANIFEST}"

require_bin psql
require_bin gunzip
require_bin tar
require_bin sha256sum
require_bin jq

require_env HADIR_ADMIN_DATABASE_URL

DATA_ROOT="${HADIR_DATA_ROOT:-/data}"
BACKUP_DIR=$(dirname "${MANIFEST}")

log "manifest: ${MANIFEST}"
log "backup dir: ${BACKUP_DIR}"

# ---- 1. checksum validation -----------------------------------

log "verifying checksums..."
checksum_failures=0
while IFS=$'\t' read -r path expected; do
    full="${BACKUP_DIR}/${path}"
    if [ ! -f "${full}" ]; then
        log "MISSING: ${path}"
        checksum_failures=$((checksum_failures + 1))
        continue
    fi
    actual=$(sha256sum "${full}" | awk '{print $1}')
    if [ "${actual}" != "${expected}" ]; then
        log "MISMATCH: ${path} (expected ${expected}, got ${actual})"
        checksum_failures=$((checksum_failures + 1))
    fi
done < <(jq -r '.files[] | [.path, .sha256] | @tsv' "${MANIFEST}")

if [ "${checksum_failures}" -gt 0 ]; then
    die "${checksum_failures} checksum failure(s); aborting before any destructive action"
fi
log "checksum verification ok (all $(jq '.files|length' "${MANIFEST}") files)"

# ---- 2. blast-radius probe ------------------------------------

log "probing target cluster..."
TARGET_TENANT_COUNT=$(
    psql "${HADIR_ADMIN_DATABASE_URL}" -At -c \
        "SELECT count(*) FROM public.tenants" 2>/dev/null \
        || echo "0"
)
TARGET_SCHEMAS=$(
    psql "${HADIR_ADMIN_DATABASE_URL}" -At -c \
        "SELECT string_agg(schema_name, ',') FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','pg_toast','information_schema','public')" \
        2>/dev/null || echo ""
)

log "target has ${TARGET_TENANT_COUNT} tenant rows"
log "target has non-system schemas: ${TARGET_SCHEMAS:-<none>}"

NON_EMPTY=0
if [ "${TARGET_TENANT_COUNT}" -gt 0 ] || [ -n "${TARGET_SCHEMAS}" ]; then
    NON_EMPTY=1
fi

# ---- 3. destructive-confirm gate ------------------------------

if [ "${NON_EMPTY}" = "1" ]; then
    log "WARNING: target cluster is NOT empty. Restore will DROP and RECREATE every schema in the manifest."
    log "         tenants: ${TARGET_TENANT_COUNT}"
    log "         schemas: ${TARGET_SCHEMAS:-<none>}"
    if [ "${HADIR_ENV:-dev}" = "production" ] && [ "${ASSUME_YES}" != "1" ]; then
        die "HADIR_ENV=production with non-empty target — pass --yes-i-have-a-backup-of-the-target after taking a confirmed backup of the target"
    fi
    if [ "${ASSUME_YES}" != "1" ]; then
        # Read the typed confirmation. Bash ``read`` on non-tty
        # would silently succeed with empty input; force it to
        # use /dev/tty so a script can't accidentally bypass.
        if [ ! -t 0 ] && [ ! -e /dev/tty ]; then
            die "no tty for confirmation; pass --yes-i-have-a-backup-of-the-target if running non-interactively"
        fi
        printf 'Type RESTORE (uppercase) to proceed: '
        if [ -e /dev/tty ]; then
            read -r confirm </dev/tty
        else
            read -r confirm
        fi
        if [ "${confirm}" != "RESTORE" ]; then
            die "confirmation not received (got '${confirm}'); aborting"
        fi
    else
        log "--yes-i-have-a-backup-of-the-target flag set; skipping typed confirmation"
    fi
fi

# ---- 4. restore the database ----------------------------------

# Restore in two passes:
#   * ``public`` first (tenant registry + super-admin).
#   * ``main`` next (legacy / pilot tenant).
#   * each per-tenant schema after, in alphabetical order.
# Each pg_dump file already starts with ``DROP SCHEMA ... CASCADE``
# and ``CREATE SCHEMA`` (we passed --clean --if-exists at backup
# time), so the destination ends up with exactly what the source
# had.

readarray -t SCHEMAS < <(jq -r '.schemas[]' "${MANIFEST}")
log "schemas to restore: ${SCHEMAS[*]}"

# ---- 4a. drop every schema first ------------------------------
#
# The per-schema pg_dump uses ``--clean --if-exists`` so each
# dump file starts with ``DROP TABLE`` for its own tables. That
# isn't enough on its own: cross-schema FK constraints in the
# *other* per-tenant schemas reference ``public.tenants``, so
# ``DROP TABLE public.tenants`` fails with "constraint X on
# table Y depends on this index".
#
# The fix is to drop every schema in the manifest upfront in
# reverse dependency order (per-tenant first, then ``main``,
# then ``public``) using ``CASCADE``. The pg_dump files then
# recreate everything cleanly.
#
# We deliberately exclude ``public`` from the cascade list and
# instead drop only the Hadir tables on it — Postgres rejects
# ``DROP SCHEMA public CASCADE`` on a freshly-initdb'd cluster
# because system catalogs live there.

ordered_schemas=()
# Restore order: public first, then main, then the rest.
[[ " ${SCHEMAS[*]} " == *" public "* ]] && ordered_schemas+=("public")
[[ " ${SCHEMAS[*]} " == *" main "* ]] && ordered_schemas+=("main")
for s in "${SCHEMAS[@]}"; do
    [ "${s}" = "public" ] && continue
    [ "${s}" = "main" ] && continue
    ordered_schemas+=("${s}")
done

# Drop in reverse: per-tenant first, then main, then public.
log "dropping schemas (reverse dependency order)..."
for (( idx=${#ordered_schemas[@]}-1; idx>=0; idx-- )); do
    schema="${ordered_schemas[$idx]}"
    if [ "${schema}" = "public" ]; then
        # Don't drop the schema itself — drop the tables Hadir
        # owns inside it (every dependent FK from main and the
        # tenant schemas is gone by now).
        log "drop public.* (Hadir tables only, not the schema)"
        psql "${HADIR_ADMIN_DATABASE_URL}" --set ON_ERROR_STOP=1 -c \
            "DROP TABLE IF EXISTS public.tenants CASCADE;
             DROP TABLE IF EXISTS public.mts_staff CASCADE;
             DROP TABLE IF EXISTS public.super_admin_sessions CASCADE;
             DROP TABLE IF EXISTS public.super_admin_audit CASCADE;" \
            || die "drop public Hadir tables failed"
    else
        log "DROP SCHEMA ${schema} CASCADE"
        psql "${HADIR_ADMIN_DATABASE_URL}" --set ON_ERROR_STOP=1 -c \
            "DROP SCHEMA IF EXISTS \"${schema}\" CASCADE" \
            || die "drop ${schema} failed"
    fi
done

# ---- 4b. restore each schema ---------------------------------

for schema in "${ordered_schemas[@]}"; do
    dump="${BACKUP_DIR}/db/${schema}.sql.gz"
    [ -f "${dump}" ] || die "missing schema dump in backup: ${dump}"
    log "restoring schema=${schema} from ${dump}"
    if [ "${schema}" = "public" ]; then
        # ``public`` always exists on a freshly-initdb'd
        # cluster (the citext extension lives there), and we
        # left it alone in the drop pass above. The dump emits
        # a ``CREATE SCHEMA public;`` line that would error;
        # strip it (and its companion COMMENT) before applying.
        gunzip -c "${dump}" \
            | sed -E '/^CREATE SCHEMA public;/d; /^COMMENT ON SCHEMA public IS/d' \
            | psql "${HADIR_ADMIN_DATABASE_URL}" --set ON_ERROR_STOP=1 -v ON_ERROR_STOP=on \
            || die "psql restore failed for ${schema}"
    else
        gunzip -c "${dump}" \
            | psql "${HADIR_ADMIN_DATABASE_URL}" --set ON_ERROR_STOP=1 -v ON_ERROR_STOP=on \
            || die "psql restore failed for ${schema}"
    fi
done

# ---- 5. restore on-disk artifacts -----------------------------

if [ "${SKIP_DATA}" = "1" ]; then
    log "--skip-data set; not restoring /data tarballs"
else
    mkdir -p "${DATA_ROOT}"
    for sub in faces attachments branding erp reports; do
        archive="${BACKUP_DIR}/data/${sub}.tar.gz"
        if [ ! -f "${archive}" ]; then
            log "skip ${sub} — not in backup"
            continue
        fi
        # Wipe the destination subtree before extracting so a
        # restored tenant doesn't carry leftovers from the host.
        log "restoring ${sub} -> ${DATA_ROOT}/${sub}"
        rm -rf "${DATA_ROOT:?}/${sub}"
        mkdir -p "${DATA_ROOT}/${sub}"
        tar -xzf "${archive}" -C "${DATA_ROOT}" \
            || die "tar extract failed for ${sub}"
    done
fi

# ---- 6. smoke check -------------------------------------------

log "post-restore probe..."
RESTORED_TENANTS=$(
    psql "${HADIR_ADMIN_DATABASE_URL}" -At -c \
        "SELECT count(*) FROM public.tenants" \
        || echo "?"
)
log "restored tenants: ${RESTORED_TENANTS}"

RESTORED_USERS=$(
    psql "${HADIR_ADMIN_DATABASE_URL}" -At -c \
        "SELECT count(*) FROM main.users WHERE is_active" \
        2>/dev/null || echo "?"
)
log "restored active users in main: ${RESTORED_USERS}"

log "restore complete"
