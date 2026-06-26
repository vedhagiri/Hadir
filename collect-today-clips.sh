#!/usr/bin/env bash
#
# collect-today-clips.sh — ONE-SHOT collection of TODAY's clips + UC1/UC2
# processing data, to analyse OFFLINE *why per-clip processing is slow*.
# Run from the maugood repo root ON THE CLIENT. Output: today-clips-<ts>.tgz
#
#   bash collect-today-clips.sh
#   # multi-tenant?        ->  SCHEMA=tenant_<slug> bash collect-today-clips.sh
#   # exact lower bound    ->  SINCE='2026-06-24 00:00:00' bash collect-today-clips.sh
#   # cap volume (disk)    ->  MAX_CLIPS=150 MAX_QUEUED=150 bash collect-today-clips.sh
#   # pull anyway (DANGER) ->  FORCE=1 bash collect-today-clips.sh
#
# WHY THIS EXISTS
#   The Pipeline Monitor shows a backlog (UC1/UC2 cropping queues filling,
#   1 worker each). To find the per-clip cost + the queue delay we need:
#   (a) the timing the pipeline recorded for EVERY clip yesterday+today,
#   (b) the COMPLETED clip videos (slowest first) to replay offline, and
#   (c) the QUEUED clip videos still waiting — so we can see what the worker
#   is about to chew through. Replay offline via backend/scripts/benchmark_uc1.py.
#
# WINDOW: default = last 48h (yesterday + today so far). Override with SINCE
#   for an exact cut. QUEUED clips are collected regardless of age.
#
# WHAT IT COLLECTS
#   1 PER-CLIP TIMING CSVs (the analysis gold — small, complete, ALWAYS run):
#       * clip_timing.csv    — one row per (clip, use_case): duration_ms,
#                              face_extract_duration_ms, match_duration_ms,
#                              face_crop_count, frame_count, filesize, fps,
#                              resolution, encode_seconds, status, error
#       * queue_status.csv   — UC1/UC2 row counts by status (the backlog)
#       * slowest_clips.csv  — top-50 slowest clips, both UCs side by side
#       * queued_clips.csv   — every pending/processing clip + how long it has
#                              been waiting (the queue delay, per clip)
#   2 ORIGINAL CLIP VIDEOS (decrypted; gated by the disk preflight below):
#       a COMPLETED clips, slowest-first, up to ${MAX_CLIPS}
#           -> clips/clip_{id}_dur{ms}ms_{frames}f.mp4
#       b QUEUED clips (pending/processing — the actual backlog), FIFO oldest
#           first, up to ${MAX_QUEUED}, NOT time-windowed.
#           -> clips/queued/clip_{id}_QUEUED_{frames}f.mp4
#   3 FACE CROPS produced by UC1 + UC2 for completed clips (decrypted, capped)
#   4 backend logs (window) + reprocess/queue/contention grep
#   5 host CPU/RAM/disk + ~40s docker stats + non-secret MAUGOOD_* knobs
#       + capture worker count
#
# DISK SAFETY: 2 days x 21 cameras of video can be many GB and the client box
#   runs LIVE capture — filling its disk would crash it. A preflight estimates
#   decrypt size vs free space and, if it won't fit, pulls the QUEUED backlog +
#   ALL CSVs only (or CSVs only), never the box. FORCE=1 overrides (DANGER).
#
# SECURITY / PII
#   * Master Fernet key NEVER leaves the box (clips + crops decrypted here).
#   * Tarball holds decrypted employee-face video + crops (PII). Keep secure,
#     NEVER push to GitHub, delete after offline testing.
#   * Secrets are redacted from knobs; a defensive scan runs at the end.
# ---------------------------------------------------------------------------
set -uo pipefail   # NOT -e: one failed step must not abort the whole run

# ---- config (override via env) --------------------------------------------
HOURS="${HOURS:-48}"               # window: 48h = yesterday + today so far (tz-safe). Override SINCE for an exact cut.
SINCE="${SINCE:-}"                 # optional exact lower bound, e.g. SINCE='2026-06-24 00:00:00' (overrides HOURS)
MAX_CLIPS="${MAX_CLIPS:-100000}"   # cap decrypted COMPLETED clips (slowest first). default = effectively ALL
MAX_QUEUED="${MAX_QUEUED:-100000}" # cap decrypted QUEUED clips (pending/processing). default = ALL
MAX_CROPS="${MAX_CROPS:-2000}"     # cap decrypted face crops
FORCE="${FORCE:-0}"                # 1 = decrypt videos even if the size estimate exceeds free disk (DANGER on a live box)
SCHEMA="${SCHEMA:-main}"           # 'main' single-tenant, else tenant_<slug>
DB_USER="${DB_USER:-maugood}"
DB_NAME="${DB_NAME:-maugood}"
BACKEND_SVC="${BACKEND_SVC:-backend}"
PG_SVC="${PG_SVC:-}"               # auto-detected if empty

TS="$(date +%Y%m%d-%H%M%S)"
OUT="today-clips-${TS}"
mkdir -p "$OUT"
LOG="$OUT/collect.log"
log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
have(){ command -v "$1" >/dev/null 2>&1; }

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif have docker-compose;            then DC="docker-compose"
else echo "ERROR: docker compose not found"; exit 1; fi

if [ -z "$PG_SVC" ]; then
  PG_SVC="$($DC ps --services 2>/dev/null | grep -iE 'postgres|^db$|database' | head -1)"
  [ -z "$PG_SVC" ] && PG_SVC="postgres"
fi

# Window predicates. SINCE (exact timestamp) wins; else rolling HOURS.
# CLIP_WHERE filters person_clips.clip_start; CPR_WHERE filters
# clip_processing_results.created_at. Queued clips are NEVER windowed
# (status-based) so the whole backlog is captured however old.
if [ -n "$SINCE" ]; then
  CLIP_WHERE="pc.clip_start >= '${SINCE}'"
  CPR_WHERE="created_at >= '${SINCE}'"
  WINDOW_DESC="since ${SINCE}"
else
  CLIP_WHERE="pc.clip_start > now() - interval '${HOURS} hours'"
  CPR_WHERE="created_at > now() - interval '${HOURS} hours'"
  WINDOW_DESC="last ${HOURS}h (yesterday + today)"
fi

log "=================================================================="
log " collect-today-clips | $DC"
log " backend=$BACKEND_SVC pg=$PG_SVC schema=$SCHEMA window=${WINDOW_DESC}"
log " max_clips=$MAX_CLIPS max_queued=$MAX_QUEUED max_crops=$MAX_CROPS force=$FORCE"
log "=================================================================="

# ---- TIER 1: per-clip timing CSVs (the analysis gold) ---------------------
log "TIER1: per-clip timing CSV (clip x use_case)…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c "\copy ( \
  SELECT cpr.person_clip_id AS clip_id, cpr.use_case, cpr.status, \
         cpr.duration_ms, cpr.face_extract_duration_ms, cpr.match_duration_ms, \
         cpr.face_crop_count, cpr.unknown_count, \
         pc.camera_id, pc.frame_count, pc.duration_seconds, pc.filesize_bytes, \
         pc.chunk_count, pc.fps_recorded, pc.resolution_w, pc.resolution_h, \
         pc.recording_status, \
         round(EXTRACT(EPOCH FROM (pc.encoding_end_at - pc.encoding_start_at))::numeric,2) AS encode_seconds, \
         pc.clip_start, cpr.started_at, cpr.ended_at, cpr.created_at, \
         left(coalesce(cpr.error,''),200) AS error \
  FROM ${SCHEMA}.clip_processing_results cpr \
  JOIN ${SCHEMA}.person_clips pc ON pc.id = cpr.person_clip_id \
  WHERE ${CLIP_WHERE} \
  ORDER BY cpr.duration_ms DESC NULLS LAST \
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUT/clip_timing.csv" 2>>"$LOG" && log "  clip_timing.csv ok" \
  || log "  WARN: clip_timing.csv failed (check SCHEMA/PG_SVC/DB_USER)"

log "TIER1: queue status counts (the backlog)…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c "\copy ( \
  SELECT use_case, status, count(*) AS n, \
         round(avg(duration_ms))           AS avg_total_ms, \
         round(avg(face_extract_duration_ms)) AS avg_extract_ms, \
         round(avg(match_duration_ms))     AS avg_match_ms, \
         round(avg(face_crop_count),2)     AS avg_crops \
  FROM ${SCHEMA}.clip_processing_results \
  WHERE ${CPR_WHERE} \
  GROUP BY use_case, status ORDER BY use_case, status \
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUT/queue_status.csv" 2>>"$LOG" && log "  queue_status.csv ok" || log "  WARN: queue_status.csv failed"

log "TIER1: slowest clips (UC1 vs UC2 side by side)…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c "\copy ( \
  SELECT pc.id AS clip_id, pc.camera_id, pc.frame_count, pc.duration_seconds, \
         round(pc.filesize_bytes/1024.0/1024.0,1) AS size_mb, \
         max(CASE WHEN cpr.use_case='uc1' THEN cpr.duration_ms END)             AS uc1_total_ms, \
         max(CASE WHEN cpr.use_case='uc1' THEN cpr.face_extract_duration_ms END) AS uc1_extract_ms, \
         max(CASE WHEN cpr.use_case='uc1' THEN cpr.match_duration_ms END)        AS uc1_match_ms, \
         max(CASE WHEN cpr.use_case='uc1' THEN cpr.face_crop_count END)          AS uc1_crops, \
         max(CASE WHEN cpr.use_case='uc2' THEN cpr.duration_ms END)             AS uc2_total_ms, \
         max(CASE WHEN cpr.use_case='uc2' THEN cpr.face_extract_duration_ms END) AS uc2_extract_ms, \
         max(CASE WHEN cpr.use_case='uc2' THEN cpr.match_duration_ms END)        AS uc2_match_ms, \
         max(CASE WHEN cpr.use_case='uc2' THEN cpr.face_crop_count END)          AS uc2_crops \
  FROM ${SCHEMA}.person_clips pc \
  JOIN ${SCHEMA}.clip_processing_results cpr ON cpr.person_clip_id = pc.id \
  WHERE ${CLIP_WHERE} \
  GROUP BY pc.id, pc.camera_id, pc.frame_count, pc.duration_seconds, pc.filesize_bytes \
  ORDER BY greatest(coalesce(max(CASE WHEN cpr.use_case='uc1' THEN cpr.duration_ms END),0), \
                    coalesce(max(CASE WHEN cpr.use_case='uc2' THEN cpr.duration_ms END),0)) DESC \
  LIMIT 50 \
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUT/slowest_clips.csv" 2>>"$LOG" && log "  slowest_clips.csv ok" || log "  WARN: slowest_clips.csv failed"

log "TIER1: queued clips (pending/processing backlog + wait time)…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c "\copy ( \
  SELECT pc.id AS clip_id, pc.camera_id, pc.frame_count, pc.duration_seconds, \
         round(pc.filesize_bytes/1024.0/1024.0,1) AS size_mb, \
         pc.recording_status, pc.face_crops_status, \
         string_agg(cpr.use_case || ':' || cpr.status, ',' ORDER BY cpr.use_case) AS uc_states, \
         pc.clip_start, \
         round(EXTRACT(EPOCH FROM (now() - min(cpr.created_at)))) AS waiting_seconds \
  FROM ${SCHEMA}.person_clips pc \
  JOIN ${SCHEMA}.clip_processing_results cpr ON cpr.person_clip_id = pc.id \
  WHERE cpr.status IN ('pending','processing') \
  GROUP BY pc.id, pc.camera_id, pc.frame_count, pc.duration_seconds, pc.filesize_bytes, \
           pc.recording_status, pc.face_crops_status, pc.clip_start \
  ORDER BY min(cpr.created_at) ASC \
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUT/queued_clips.csv" 2>>"$LOG" && log "  queued_clips.csv ok" || log "  WARN: queued_clips.csv failed"

# ---- DISK SAFETY PREFLIGHT (protect the live client box) ------------------
# Decrypting yesterday+today across 21 cameras can be many GB. The client
# box runs production capture; filling its disk would crash it. Estimate the
# decrypt size vs free space and, unless FORCE=1, skip the VIDEO tiers (the
# CSVs above already carry processing time for EVERY clip — the core data).
log "PREFLIGHT: estimating decrypt size vs free disk…"
psum(){ $DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1" 2>>"$LOG" | tr -d '[:space:]'; }
# Total = windowed COMPLETED clips + ALL queued (what the run wants to pull).
NEED_TOTAL="$(psum "SELECT coalesce(sum(filesize_bytes),0) FROM ${SCHEMA}.person_clips pc \
   WHERE pc.file_path IS NOT NULL AND pc.clip_file_deleted_at IS NULL \
     AND ( ${CLIP_WHERE} \
           OR pc.id IN (SELECT person_clip_id FROM ${SCHEMA}.clip_processing_results \
                        WHERE status IN ('pending','processing')) )")"
# Queued only = the backlog (the priority; usually small).
NEED_QUEUED="$(psum "SELECT coalesce(sum(filesize_bytes),0) FROM ${SCHEMA}.person_clips pc \
   WHERE pc.file_path IS NOT NULL AND pc.clip_file_deleted_at IS NULL \
     AND pc.id IN (SELECT person_clip_id FROM ${SCHEMA}.clip_processing_results \
                   WHERE status IN ('pending','processing'))")"
[ -z "$NEED_TOTAL" ] && NEED_TOTAL=0
[ -z "$NEED_QUEUED" ] && NEED_QUEUED=0
FREE_BYTES="$(df -Pk . 2>/dev/null | awk 'NR==2{print $4*1024}')"
[ -z "$FREE_BYTES" ] && FREE_BYTES=0
# Peak transient usage ~= container /tmp copy + host copy + tarball ≈ 3x.
gb(){ awk -v b="$1" 'BEGIN{printf "%.1f", b/1024/1024/1024}'; }
log "PREFLIGHT: total in window ≈ $(gb "$NEED_TOTAL") GB | queued backlog ≈ $(gb "$NEED_QUEUED") GB | free here ≈ $(gb "$FREE_BYTES") GB"

if [ "$FORCE" = "1" ] || [ "$(( NEED_TOTAL * 3 ))" -le "$FREE_BYTES" ]; then
  log "PREFLIGHT: OK — pulling COMPLETED + QUEUED clips + crops."
elif [ "$(( NEED_QUEUED * 3 ))" -le "$FREE_BYTES" ]; then
  # Full 2-day set won't fit, but the queued backlog will — keep the priority.
  MAX_CLIPS=0; MAX_CROPS=0
  log "PREFLIGHT: ⚠ full window too big for disk — pulling QUEUED backlog + ALL CSVs only."
  log "PREFLIGHT:   completed-clip videos + crops SKIPPED (their timing is in clip_timing.csv)."
  log "PREFLIGHT:   To also pull completed videos: free disk, cap (MAX_CLIPS=150), or FORCE=1."
else
  # Even the queue won't fit — protect the box, ship CSVs only.
  MAX_CLIPS=0; MAX_QUEUED=0; MAX_CROPS=0
  log "PREFLIGHT: ⚠ NOT enough headroom for ANY video decrypt — SKIPPING all video/crop pulls."
  log "PREFLIGHT:   CSVs (processing time for ALL clips incl. queued) are still collected."
  log "PREFLIGHT:   Free disk and re-run, cap (MAX_QUEUED=150), or FORCE=1 (DANGER on a live box)."
fi

# ---- TIER 2: decrypt the SLOWEST clips (key stays on box) ------------------
log "TIER2: decrypting up to ${MAX_CLIPS} COMPLETED clips (slowest first)…"
$DC exec -T -e SINCE="$SINCE" -e HOURS="$HOURS" -e MAXC="$MAX_CLIPS" -e SCHEMA="$SCHEMA" "$BACKEND_SVC" python - <<'PY' 2>>"$LOG"
import os
from pathlib import Path
from sqlalchemy import text
from maugood.db import get_engine, tenant_context
from maugood.employees.photos import decrypt_bytes
schema = os.environ.get("SCHEMA", "main")
since = os.environ.get("SINCE", "").strip()
hours = int(os.environ.get("HOURS", "48"))
maxc = int(os.environ.get("MAXC", "100000"))
out = Path("/tmp/todayclips/clips"); out.mkdir(parents=True, exist_ok=True)
if since:
    where, params = "pc.clip_start >= :since", {"since": since, "maxc": maxc}
else:
    where, params = f"pc.clip_start > now() - interval '{hours} hours'", {"maxc": maxc}
q = text(f"""
  SELECT pc.id, pc.file_path, pc.frame_count,
         max(cpr.duration_ms) AS dur
  FROM person_clips pc
  JOIN clip_processing_results cpr ON cpr.person_clip_id = pc.id
  WHERE {where}
    AND pc.file_path IS NOT NULL
    AND pc.clip_file_deleted_at IS NULL
  GROUP BY pc.id, pc.file_path, pc.frame_count
  ORDER BY dur DESC NULLS LAST
  LIMIT :maxc
""")
ok = skip = 0
with tenant_context(schema):
    with get_engine().begin() as conn:
        rows = conn.execute(q, params).fetchall()
print(f"selected {len(rows)} completed clip(s) for decrypt (schema={schema})")
for cid, fpath, frames, dur in rows:
    try:
        data = Path(fpath).read_bytes()
        try:
            data = decrypt_bytes(data)          # encrypted (encode + stream_copy)
        except Exception:
            pass                                # already plaintext — keep as-is
        d = dur if dur is not None else 0
        f = frames if frames is not None else 0
        (out / f"clip_{cid}_dur{d}ms_{f}f.mp4").write_bytes(data)
        ok += 1
    except Exception as e:
        print("skip clip", cid, type(e).__name__, str(e)[:80]); skip += 1
print(f"decrypted {ok}, skipped {skip}")
PY

# ---- TIER 2b: decrypt the QUEUED clips (the backlog, FIFO oldest first) ----
log "TIER2b: decrypting up to ${MAX_QUEUED} QUEUED clips (pending/processing)…"
$DC exec -T -e MAXQ="$MAX_QUEUED" -e SCHEMA="$SCHEMA" "$BACKEND_SVC" python - <<'PY' 2>>"$LOG"
import os
from pathlib import Path
from sqlalchemy import text
from maugood.db import get_engine, tenant_context
from maugood.employees.photos import decrypt_bytes
schema = os.environ.get("SCHEMA", "main")
maxq = int(os.environ.get("MAXQ", "100"))
out = Path("/tmp/todayclips/clips/queued"); out.mkdir(parents=True, exist_ok=True)
# NOT time-windowed — grab the whole backlog however old. FIFO: oldest
# enqueued first, i.e. the order the worker will actually process them.
q = text("""
  SELECT pc.id, pc.file_path, pc.frame_count, min(cpr.created_at) AS enq
  FROM person_clips pc
  JOIN clip_processing_results cpr ON cpr.person_clip_id = pc.id
  WHERE cpr.status IN ('pending','processing')
    AND pc.file_path IS NOT NULL
    AND pc.clip_file_deleted_at IS NULL
  GROUP BY pc.id, pc.file_path, pc.frame_count
  ORDER BY enq ASC
  LIMIT :maxq
""")
ok = skip = 0
with tenant_context(schema):
    with get_engine().begin() as conn:
        rows = conn.execute(q, {"maxq": maxq}).fetchall()
print(f"selected {len(rows)} queued clip(s) (schema={schema})")
for cid, fpath, frames, enq in rows:
    try:
        data = Path(fpath).read_bytes()
        try:
            data = decrypt_bytes(data)
        except Exception:
            pass
        f = frames if frames is not None else 0
        (out / f"clip_{cid}_QUEUED_{f}f.mp4").write_bytes(data)
        ok += 1
    except Exception as e:
        print("skip queued clip", cid, type(e).__name__, str(e)[:80]); skip += 1
print(f"decrypted {ok} queued, skipped {skip}")
PY

# ---- TIER 3: face crops for those clips (decrypted) -----------------------
log "TIER3: decrypting UC1/UC2 face crops (cap ${MAX_CROPS})…"
$DC exec -T -e WIN="$WIN" -e MAXCR="$MAX_CROPS" -e SCHEMA="$SCHEMA" "$BACKEND_SVC" python - <<'PY' 2>>"$LOG"
import os
from pathlib import Path
from sqlalchemy import text
from maugood.db import get_engine, tenant_context
from maugood.employees.photos import decrypt_bytes
schema = os.environ.get("SCHEMA", "main")
win = os.environ.get("WIN", "24 hours")
maxcr = int(os.environ.get("MAXCR", "600"))
out = Path("/tmp/todayclips/crops"); out.mkdir(parents=True, exist_ok=True)
q = text(f"""
  SELECT fc.person_clip_id, fc.use_case, fc.id, fc.file_path,
         fc.quality_score, fc.width, fc.height, fc.employee_id
  FROM face_crops fc
  JOIN person_clips pc ON pc.id = fc.person_clip_id
  WHERE pc.clip_start > now() - interval :win
    AND fc.file_path IS NOT NULL
  ORDER BY fc.person_clip_id, fc.use_case, fc.id
  LIMIT :maxcr
""")
ok = skip = 0
with tenant_context(schema):
    with get_engine().begin() as conn:
        rows = conn.execute(q, {"win": win, "maxcr": maxcr}).fetchall()
print(f"selected {len(rows)} crop(s)")
for clip_id, uc, fcid, fpath, qual, w, h, emp in rows:
    try:
        uc = uc or "ucX"
        d = out / uc / f"clip_{clip_id}"; d.mkdir(parents=True, exist_ok=True)
        data = decrypt_bytes(Path(fpath).read_bytes())
        ql = int(round((qual or 0) * 100))
        em = f"emp{emp}" if emp else "unknown"
        (d / f"crop_{fcid}_q{ql}_{w}x{h}_{em}.jpg").write_bytes(data)
        ok += 1
    except Exception as e:
        print("skip crop", fcid, type(e).__name__); skip += 1
print(f"decrypted {ok} crops, skipped {skip}")
PY

# ---- TIER 4: logs ---------------------------------------------------------
log "TIER4: backend logs (last ${HOURS}h)…"
$DC logs --since "${HOURS}h" "$BACKEND_SVC" > "$OUT/backend.log" 2>&1 || true
grep -iE "reprocess detect|uc1|uc2|extract|crop|motion|detect_lock|contention|matcher|queue|worker|error|traceback" \
  "$OUT/backend.log" > "$OUT/backend-relevant.log" 2>/dev/null || true
$DC cp "$BACKEND_SVC:/app/logs" "$OUT/backend-logs-ondisk" 2>>"$LOG" || log "  (no /app/logs on disk — skipped)"

# ---- TIER 5: host load + knobs + workers ----------------------------------
log "TIER5: host spec…"
{ echo "## lscpu"; lscpu; echo; echo "## nproc"; nproc; echo; echo "## free -h"; free -h; echo; echo "## df -h"; df -h; } > "$OUT/host-spec.txt" 2>&1

log "TIER5: docker stats (~40s, background)…"
( for _ in $(seq 8); do docker stats --no-stream 2>/dev/null; echo "----- $(date +%H:%M:%S)"; sleep 5; done ) > "$OUT/load.txt" 2>&1 &
STATS_PID=$!

log "TIER5: perf knobs (secrets redacted)…"
$DC exec -T "$BACKEND_SVC" env 2>/dev/null \
  | grep -E '^MAUGOOD_' | grep -viE 'KEY|SECRET|PASSWORD|TOKEN|FERNET|_URL|DSN|HASH' \
  | sort > "$OUT/knobs.txt" || true

log "TIER5: active capture workers…"
$DC exec -T "$BACKEND_SVC" python -c \
  "from maugood.capture.manager import capture_manager as m; print('active_workers', len(m.workers_snapshot()))" \
  > "$OUT/workers.txt" 2>>"$LOG" || true

# ---- pull container-side artifacts (clips + crops) ------------------------
log "pulling container-side artifacts (clips, crops)…"
$DC cp "$BACKEND_SVC:/tmp/todayclips" "$OUT/from-container" 2>>"$LOG" \
  && log "  pulled -> $OUT/from-container" || log "  WARN: container pull failed (see collect.log)"

# ---- finalize -------------------------------------------------------------
wait "$STATS_PID" 2>/dev/null || true
log "load snapshot complete."
$DC exec -T "$BACKEND_SVC" rm -rf /tmp/todayclips 2>/dev/null || true

log "scanning bundle for accidental plaintext secrets…"
if grep -rIlE 'BEGIN [A-Z ]*PRIVATE KEY|SESSION_SECRET|[A-Z_]*PASSWORD=' "$OUT" 2>/dev/null; then
  log "  ⚠ review files listed above before sharing"
else
  log "  clean"
fi

TAR="${OUT}.tgz"
tar czf "$TAR" "$OUT" 2>/dev/null && rm -rf "$OUT"
log "=================================================================="
log " DONE → $TAR  ($(du -h "$TAR" 2>/dev/null | cut -f1))"
log "=================================================================="
echo
echo "Download: $TAR"
echo "Backlog analysis:  queue_status.csv (depth) + queued_clips.csv (per-clip wait)"
echo "Per-clip cost:     clip_timing.csv + slowest_clips.csv"
echo "Replay offline:    completed -> clips/*.mp4 ; backlog -> clips/queued/*.mp4"
echo "                   through backend/scripts/benchmark_uc1.py"
echo "⚠ Contains decrypted employee-face video + crops (PII). Keep secure,"
echo "  do NOT push to GitHub, delete after offline testing."
