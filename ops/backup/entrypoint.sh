#!/usr/bin/env bash
# Maugood backup container entrypoint (v1.0 P24).
#
# Two run modes:
#
#   * No args: long-running supercronic. Reads
#     /etc/supercronic/crontab and fires backup.sh on the
#     schedule. ``docker logs`` shows every script invocation.
#   * "once": one-shot — runs backup.sh immediately and exits.
#     Useful for ad-hoc snapshots and the DR rehearsal smoke.
#
# Either way the script lives at /app/scripts/backup.sh,
# bind-mounted from backend/scripts/ in compose.

set -eu

if [ "${1:-}" = "once" ]; then
    shift
    exec /app/scripts/backup.sh "$@"
fi

# Validate the script + crontab before the daemon takes over —
# a typo in either should fail the container start, not silently
# swallow.
test -x /app/scripts/backup.sh || {
    echo "fatal: /app/scripts/backup.sh missing or not executable" >&2
    exit 2
}
test -f /etc/supercronic/crontab || {
    echo "fatal: /etc/supercronic/crontab missing" >&2
    exit 2
}

echo "[backup-entry] starting supercronic with TZ=${TZ:-UTC}" >&2
exec /usr/local/bin/supercronic /etc/supercronic/crontab
