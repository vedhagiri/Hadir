#!/usr/bin/env bash
#
# os_watch.sh — the can't-fail diagnostic layer.
#
# A tiny, dependency-free OS-level sampler. It reads /proc + coreutils
# only, so it keeps recording even when the backend (and the Python
# camera_diagnostics collector) are CPU-starved or wedged. Run it ON THE
# HOST — not inside the container — so that an OOM-kill of the backend
# container can't take the logger down with it.
#
# It answers the "will I still capture data if the box freezes?" worry:
# host CPU/mem/swap, the top resource-consuming processes, the backend's
# RSS trend, disk free space, and — captured on exit — the kernel OOM
# killer's verdict (which is invisible to anything running inside the
# frozen app).
#
# Usage (on the host):
#   nohup ./os_watch.sh 2 /var/log/maugood-oswatch.log uvicorn &
#     arg1 = interval seconds (default 2 — high resolution for the freeze edge)
#     arg2 = output file      (default ./os-watch-<ts>.log; use a REAL disk, not tmpfs)
#     arg3 = backend match     (default "uvicorn" — process name to track RSS for)
#
# Stop with Ctrl-C (or kill); it appends the kernel OOM tail on the way out.

set -u

INTERVAL="${1:-2}"
OUTFILE="${2:-./os-watch-$(date +%Y%m%d-%H%M%S).log}"
BACKEND_MATCH="${3:-uvicorn}"

# Try to raise our scheduling priority so the kernel keeps running us
# even when everything else is starved. Needs root; ignore failure.
renice -n -5 -p "$$" >/dev/null 2>&1 || true
command -v ionice >/dev/null 2>&1 && ionice -c2 -n0 -p "$$" >/dev/null 2>&1 || true

echo "os_watch: interval=${INTERVAL}s -> ${OUTFILE} (tracking '${BACKEND_MATCH}')"
echo "os_watch: leave this running through the freeze window; Ctrl-C to stop."

dump_kernel_oom() {
    {
        echo "===== KERNEL / OOM TAIL @ $(date -Is) ====="
        if command -v journalctl >/dev/null 2>&1; then
            journalctl -k --no-pager 2>/dev/null | tail -n 80
        elif command -v dmesg >/dev/null 2>&1; then
            dmesg 2>/dev/null | tail -n 80
        else
            echo "(no journalctl/dmesg available)"
        fi
        echo "===== END KERNEL TAIL ====="
    } >>"$OUTFILE" 2>&1
}

trap 'echo "os_watch: stopping — capturing kernel OOM tail"; dump_kernel_oom; exit 0' INT TERM

# Header
{
    echo "########## os_watch start $(date -Is) ##########"
    echo "# kernel: $(uname -a)"
    echo "# cores : $(nproc 2>/dev/null || echo '?')"
    echo "# /tmp  : $(grep -E '[[:space:]]/tmp[[:space:]]' /proc/mounts || echo 'not a separate mount')"
    echo "#####################################################"
} >>"$OUTFILE" 2>&1

i=0
while true; do
    {
        echo "----- $(date -Is) -----"
        # Load average + running/total tasks
        echo "loadavg: $(cat /proc/loadavg 2>/dev/null)"
        # Memory + swap (KB) — MemAvailable is the real headroom number
        grep -E '^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback):' \
            /proc/meminfo 2>/dev/null | tr '\n' ' '
        echo ""
        # Aggregate CPU jiffies (delta vs previous line tells you busy%)
        grep -E '^cpu ' /proc/stat 2>/dev/null
        # Top 12 processes by CPU, then by memory — names the offender
        echo "-- top by %CPU --"
        ps -eo pid,ppid,%cpu,%mem,rss,nlwp,comm --sort=-%cpu 2>/dev/null | head -n 13
        echo "-- backend (${BACKEND_MATCH}) --"
        ps -eo pid,%cpu,%mem,rss,nlwp,comm 2>/dev/null | grep -E "${BACKEND_MATCH}" | grep -v grep
        # Disk free on the roots that matter (clips/segments live here)
        echo "-- disk --"
        df -h / /tmp /data /clips 2>/dev/null | grep -vE '^Filesystem' | sort -u
    } >>"$OUTFILE" 2>&1

    # Force the bytes to persistent storage every ~10 samples so a hard
    # power loss / OOM-reboot keeps what we've seen so far.
    i=$((i + 1))
    if [ $((i % 10)) -eq 0 ]; then
        sync 2>/dev/null || true
    fi

    sleep "$INTERVAL"
done
