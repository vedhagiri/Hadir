#!/usr/bin/env bash
#
# db-backup.sh — manual DB backup + restore for an operator on the
# host. One file. Three actions.
#
# What this is:
#   * ``backup``  (default) dumps the entire ``maugood`` Postgres
#                 database to ``./backups/db-<timestamp>.sql.gz``.
#                 Plain-text SQL inside the gzip — operators can
#                 ``zcat`` / ``less`` it.
#   * ``restore`` reloads a previously-taken backup. Stops the
#                 backend during the restore so it can't write,
#                 then starts it again. Type-to-confirm because
#                 every row in the live DB is replaced.
#   * ``list``    shows the backup files on disk with sizes + ages.
#
# What this is NOT:
#   The scheduled per-tenant production backup (that lives at
#   ``backend/scripts/backup.sh`` and runs inside the dedicated
#   ``backup`` container). This script is the manual sister — for
#   "I want a checkpoint before applying an update" or "give me one
#   file I can scp off-machine."
#
# Usage:
#   ./scripts/db-backup.sh                          # backup (default)
#   ./scripts/db-backup.sh backup
#   ./scripts/db-backup.sh list
#   ./scripts/db-backup.sh restore                  # interactive picker
#   ./scripts/db-backup.sh restore <file.sql.gz>
#   ./scripts/db-backup.sh restore <file.sql.gz> --yes   # automation
#
# Where the backup goes:
#   ${install_dir}/backups/db-<YYYYMMDD-HHMMSS>.sql.gz
#
# What's preserved across a restore:
#   Everything in the SQL dump — schemas, tables, role grants,
#   sequences, every row. Data on disk (face crops, attachments,
#   branding logos under /data/) is NOT touched by this script.
#   That's by design — those files are append-only and don't get
#   "lost" in the kind of incident where a DB backup helps.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_INSTALL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
ACTION="backup"
RESTORE_FILE=""
ASSUME_YES=0

# Parse: first positional arg is the action; everything else is a flag
# OR (only in restore mode) the path to the file to restore.
while [[ $# -gt 0 ]]; do
    case "$1" in
        backup)         ACTION="backup"; shift ;;
        restore)        ACTION="restore"; shift ;;
        list)           ACTION="list"; shift ;;
        --install-dir)  INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
        --yes|-y)       ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '3,40p' "$0"
            exit 0 ;;
        *)
            if [[ "${ACTION}" == "restore" && -z "${RESTORE_FILE}" ]]; then
                RESTORE_FILE="$1"
                shift
            else
                echo "error: unknown arg '$1'" >&2
                exit 2
            fi ;;
    esac
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if [[ ! -d "${INSTALL_DIR}" ]]; then
    echo "error: install dir not found at '${INSTALL_DIR}'" >&2
    exit 1
fi
if [[ ! -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    echo "error: '${INSTALL_DIR}' doesn't look like a Maugood install" >&2
    exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "error: 'docker' is required but not installed." >&2
    exit 1
fi

cd "${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# Detect the right compose file (same logic as deploy-update.sh).
# Customer installs run docker-compose-https-local.yaml — without
# ``-f`` docker would default to docker-compose.yml and target the
# wrong postgres container (or none at all if the dev stack isn't up).
# ---------------------------------------------------------------------------

COMPOSE_FILE_REL="docker-compose.yml"
if [[ -f "${INSTALL_DIR}/docker-compose-https-local.yaml" ]]; then
    running_https="$(
        docker compose -f "${INSTALL_DIR}/docker-compose-https-local.yaml" \
            ps -q 2>/dev/null | wc -l | tr -d ' '
    )"
    running_default="$(
        docker compose -f "${INSTALL_DIR}/docker-compose.yml" \
            ps -q 2>/dev/null | wc -l | tr -d ' '
    )"
    if [[ "${running_https:-0}" -gt 0 ]]; then
        COMPOSE_FILE_REL="docker-compose-https-local.yaml"
    elif [[ "${running_default:-0}" -gt 0 ]]; then
        COMPOSE_FILE_REL="docker-compose.yml"
    else
        # Nothing running. Default to the prod-style file because
        # ``backup`` and ``restore`` would normally run against a
        # live customer install, not a dormant dev stack.
        COMPOSE_FILE_REL="docker-compose-https-local.yaml"
    fi
fi

# ---------------------------------------------------------------------------
# Helpers shared across actions
# ---------------------------------------------------------------------------

BACKUPS_DIR="${INSTALL_DIR}/backups"
mkdir -p "${BACKUPS_DIR}"

DC=(docker compose -f "${COMPOSE_FILE_REL}")

# Read the admin DB password from .env so pg_dump / psql don't have
# to rely on Unix-socket peer auth inside the container. PG accepts
# ``-h localhost`` + ``PGPASSWORD`` regardless of pg_hba.conf
# tweaks.
DB_PASSWORD=""
if [[ -f "${INSTALL_DIR}/.env" ]]; then
    DB_PASSWORD="$(
        grep -E '^MAUGOOD_ADMIN_DB_PASSWORD=' "${INSTALL_DIR}/.env" 2>/dev/null \
            | tail -1 | cut -d'=' -f2- | tr -d '"' || true
    )"
fi
[[ -z "${DB_PASSWORD}" ]] && DB_PASSWORD="maugood"  # compose default

ensure_postgres_running() {
    # The script runs ``docker compose exec`` against the postgres
    # service; that needs the container to be up. Start it without
    # touching anything else.
    local id
    id="$("${DC[@]}" ps -q postgres 2>/dev/null || true)"
    if [[ -z "${id}" ]]; then
        echo "  starting postgres container…"
        "${DC[@]}" up -d postgres >/dev/null
        # Give the healthcheck a moment to flip green so pg_dump
        # doesn't race the boot.
        for _ in $(seq 1 30); do
            if "${DC[@]}" exec -T -e PGPASSWORD="${DB_PASSWORD}" postgres \
                pg_isready -h localhost -U maugood -d maugood >/dev/null 2>&1; then
                return 0
            fi
            sleep 1
        done
        echo "  warning: postgres health check timed out — proceeding anyway"
    fi
}

human_size() {
    local bytes="$1"
    if (( bytes < 1024 )); then
        printf "%d B" "${bytes}"
    elif (( bytes < 1024*1024 )); then
        printf "%.1f KB" "$(echo "${bytes} 1024" | awk '{print $1/$2}')"
    elif (( bytes < 1024*1024*1024 )); then
        printf "%.1f MB" "$(echo "${bytes} 1048576" | awk '{print $1/$2}')"
    else
        printf "%.2f GB" "$(echo "${bytes} 1073741824" | awk '{print $1/$2}')"
    fi
}

# ---------------------------------------------------------------------------
# Action: list
# ---------------------------------------------------------------------------

if [[ "${ACTION}" == "list" ]]; then
    shopt -s nullglob
    files=( "${BACKUPS_DIR}"/db-*.sql.gz )
    shopt -u nullglob
    if [[ ${#files[@]} -eq 0 ]]; then
        echo "No DB backups in ${BACKUPS_DIR}"
        exit 0
    fi
    echo "DB backups in ${BACKUPS_DIR}:"
    echo
    printf "  %-40s %12s   %s\n" "FILE" "SIZE" "MODIFIED"
    for f in $(printf '%s\n' "${files[@]}" | sort -r); do
        bytes="$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f" 2>/dev/null || echo 0)"
        mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f" 2>/dev/null \
            || stat -c '%y' "$f" 2>/dev/null | cut -d'.' -f1 \
            || echo '?')"
        printf "  %-40s %12s   %s\n" "$(basename "$f")" "$(human_size "${bytes}")" "${mtime}"
    done
    exit 0
fi

# ---------------------------------------------------------------------------
# Action: backup
# ---------------------------------------------------------------------------

if [[ "${ACTION}" == "backup" ]]; then
    TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
    OUT_FILE="${BACKUPS_DIR}/db-${TIMESTAMP}.sql.gz"

    echo "================================================================"
    echo " Maugood DB backup"
    echo "================================================================"
    echo "  install dir : ${INSTALL_DIR}"
    echo "  compose     : ${COMPOSE_FILE_REL}"
    echo "  output      : ${OUT_FILE}"
    echo "================================================================"

    ensure_postgres_running

    echo
    echo ">> Running pg_dump (this may take a minute on a large DB)"
    # ``--clean --if-exists`` makes the dump self-contained for restore:
    # the SQL DROPs every object before recreating, so the operator
    # doesn't have to wipe the DB by hand first.
    # Pipe straight into gzip on the host so we don't need scratch
    # space inside the container.
    "${DC[@]}" exec -T -e PGPASSWORD="${DB_PASSWORD}" postgres \
        pg_dump \
            -h localhost \
            -U maugood \
            -d maugood \
            --clean --if-exists \
            --no-owner --no-privileges \
        | gzip > "${OUT_FILE}"

    if [[ ! -s "${OUT_FILE}" ]]; then
        echo "error: backup file is empty — pg_dump probably failed" >&2
        rm -f "${OUT_FILE}"
        exit 1
    fi

    bytes="$(stat -f '%z' "${OUT_FILE}" 2>/dev/null \
        || stat -c '%s' "${OUT_FILE}" 2>/dev/null || echo 0)"
    echo
    echo "================================================================"
    echo " ✓ Backup written"
    echo "================================================================"
    echo "  File : ${OUT_FILE}"
    echo "  Size : $(human_size "${bytes}")"
    echo
    echo "  scp to off-machine storage (recommended):"
    echo "    scp '${OUT_FILE}' user@offsite:/path/"
    echo
    echo "  Restore later with:"
    echo "    ./scripts/db-backup.sh restore '${OUT_FILE}'"
    exit 0
fi

# ---------------------------------------------------------------------------
# Action: restore
# ---------------------------------------------------------------------------

if [[ "${ACTION}" == "restore" ]]; then

    # --- Pick the file -----------------------------------------------------
    if [[ -z "${RESTORE_FILE}" ]]; then
        # Interactive picker — list files, ask for a number.
        shopt -s nullglob
        files=( "${BACKUPS_DIR}"/db-*.sql.gz )
        shopt -u nullglob
        if [[ ${#files[@]} -eq 0 ]]; then
            echo "error: no backup files in ${BACKUPS_DIR}" >&2
            echo "       Take one first: ./scripts/db-backup.sh backup" >&2
            exit 1
        fi
        # Sort newest-first so the most likely candidate is at index 1.
        IFS=$'\n' sorted=( $(printf '%s\n' "${files[@]}" | sort -r) )
        unset IFS
        echo "Pick a backup to restore:"
        echo
        i=1
        for f in "${sorted[@]}"; do
            bytes="$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f" 2>/dev/null || echo 0)"
            mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$f" 2>/dev/null \
                || stat -c '%y' "$f" 2>/dev/null | cut -d'.' -f1)"
            printf "  %2d) %-38s  %10s  %s\n" "${i}" "$(basename "$f")" "$(human_size "${bytes}")" "${mtime}"
            i=$((i + 1))
        done
        echo
        read -r -p "Number (or q to cancel): " choice
        if [[ "${choice}" =~ ^[Qq]$ || -z "${choice}" ]]; then
            echo "cancelled."
            exit 1
        fi
        if ! [[ "${choice}" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#sorted[@]} )); then
            echo "error: '${choice}' is not in the range 1..${#sorted[@]}" >&2
            exit 1
        fi
        RESTORE_FILE="${sorted[$((choice - 1))]}"
    fi

    # --- Validate it -------------------------------------------------------
    if [[ ! -f "${RESTORE_FILE}" ]]; then
        # Allow operator to pass just the filename (without path) if
        # it's in ./backups/.
        if [[ -f "${BACKUPS_DIR}/${RESTORE_FILE}" ]]; then
            RESTORE_FILE="${BACKUPS_DIR}/${RESTORE_FILE}"
        else
            echo "error: backup file not found: ${RESTORE_FILE}" >&2
            exit 1
        fi
    fi

    # Spot check: the file should start with gzip magic AND the
    # decompressed start should look like a pg_dump.
    if ! gunzip -t "${RESTORE_FILE}" 2>/dev/null; then
        echo "error: '${RESTORE_FILE}' is not a valid gzip file" >&2
        exit 1
    fi
    # ``gunzip -c`` (not ``zcat``) — portable across macOS BSD and
    # Linux. macOS's zcat looks for a .Z extension and fails on .gz.
    # Disable pipefail momentarily: ``head -c 200`` closes its read
    # end after 200 bytes, gunzip catches SIGPIPE, and pipefail then
    # fails the whole pipeline despite the read being intentional.
    set +o pipefail
    head_bytes="$(gunzip -c "${RESTORE_FILE}" 2>/dev/null | head -c 200)"
    set -o pipefail
    if ! grep -q 'PostgreSQL\|pg_dump\|SET' <<<"${head_bytes}"; then
        echo "error: '${RESTORE_FILE}' doesn't look like a pg_dump output" >&2
        exit 1
    fi

    bytes="$(stat -f '%z' "${RESTORE_FILE}" 2>/dev/null \
        || stat -c '%s' "${RESTORE_FILE}" 2>/dev/null || echo 0)"

    echo "================================================================"
    echo " Maugood DB restore"
    echo "================================================================"
    echo "  install dir : ${INSTALL_DIR}"
    echo "  compose     : ${COMPOSE_FILE_REL}"
    echo "  source      : ${RESTORE_FILE}"
    echo "  size        : $(human_size "${bytes}")"
    echo "================================================================"
    echo
    echo "  WARNING — this REPLACES every row in the live database."
    echo "  Anything written since this backup was taken will be lost."
    echo "  The backend will be stopped during the restore + restarted"
    echo "  afterwards. Data on disk under /data/ is NOT touched."
    echo

    if [[ ${ASSUME_YES} -eq 0 ]]; then
        read -r -p "Type RESTORE to confirm: " confirm
        if [[ "${confirm}" != "RESTORE" ]]; then
            echo "cancelled."
            exit 1
        fi
    fi

    ensure_postgres_running

    # Take a safety backup BEFORE clobbering — if the restore fails
    # halfway, the operator hasn't lost the live state.
    SAFETY_TS="$(date +%Y%m%d-%H%M%S)"
    SAFETY_FILE="${BACKUPS_DIR}/db-${SAFETY_TS}-pre-restore-safety.sql.gz"
    echo
    echo ">> Taking a safety pre-restore backup → ${SAFETY_FILE}"
    "${DC[@]}" exec -T -e PGPASSWORD="${DB_PASSWORD}" postgres \
        pg_dump \
            -h localhost -U maugood -d maugood \
            --clean --if-exists --no-owner --no-privileges \
        | gzip > "${SAFETY_FILE}"
    if [[ ! -s "${SAFETY_FILE}" ]]; then
        echo "error: safety backup is empty — refusing to overwrite live DB" >&2
        rm -f "${SAFETY_FILE}"
        exit 1
    fi

    # Stop the backend so it can't write into the half-restored DB.
    # ``stop`` keeps the network attached so postgres stays reachable.
    echo
    echo ">> Stopping backend during the restore"
    "${DC[@]}" stop backend 2>&1 | tail -3 || true
    # Also stop the dev frontend / nginx so the UI doesn't 502 in a
    # confusing way during the seconds-to-minutes the restore takes.
    if [[ "${COMPOSE_FILE_REL}" == "docker-compose-https-local.yaml" ]]; then
        "${DC[@]}" stop nginx 2>&1 | tail -1 || true
    else
        "${DC[@]}" stop frontend 2>&1 | tail -1 || true
    fi

    # Drop active connections to the maugood DB before restoring,
    # because pg_dump's --clean DROPs the schemas which fails with
    # connections still open.
    echo
    echo ">> Closing live connections to 'maugood'"
    "${DC[@]}" exec -T -e PGPASSWORD="${DB_PASSWORD}" postgres \
        psql -h localhost -U maugood -d postgres -c "
            SELECT pg_terminate_backend(pid)
              FROM pg_stat_activity
             WHERE datname = 'maugood' AND pid <> pg_backend_pid();
        " >/dev/null

    # Run the restore. We pipe the gunzipped SQL into psql; on any
    # SQL error the script aborts (--set ON_ERROR_STOP=1) so we don't
    # end up with a half-applied state silently.
    echo
    echo ">> Restoring (this may take a minute)"
    set +e
    gunzip -c "${RESTORE_FILE}" | "${DC[@]}" exec -T \
        -e PGPASSWORD="${DB_PASSWORD}" postgres \
        psql -h localhost -U maugood -d maugood \
            --set ON_ERROR_STOP=1 \
            --quiet > /tmp/_restore.log 2>&1
    rc=$?
    set -e
    tail -5 /tmp/_restore.log 2>/dev/null || true
    rm -f /tmp/_restore.log

    if [[ ${rc} -ne 0 ]]; then
        echo
        echo "error: restore failed (psql exit ${rc}). Live DB may be"
        echo "       half-applied. Recover with the safety backup:"
        echo
        echo "    ./scripts/db-backup.sh restore '${SAFETY_FILE}' --yes"
        echo
        exit ${rc}
    fi

    echo
    echo ">> Bringing services back up"
    "${DC[@]}" up -d backend 2>&1 | tail -3
    if [[ "${COMPOSE_FILE_REL}" == "docker-compose-https-local.yaml" ]]; then
        "${DC[@]}" up -d nginx 2>&1 | tail -1 || true
    else
        "${DC[@]}" up -d frontend 2>&1 | tail -1 || true
    fi

    echo
    echo "================================================================"
    echo " ✓ Restore complete"
    echo "================================================================"
    echo "  Restored from : ${RESTORE_FILE}"
    echo "  Safety backup : ${SAFETY_FILE}"
    echo "                  (delete once you've confirmed the restored"
    echo "                   state is correct)"
    exit 0
fi

echo "error: unknown action '${ACTION}'" >&2
exit 2
