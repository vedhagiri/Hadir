#!/usr/bin/env bash
#
# collect-uc1.sh — ONE-SHOT, LAST-DAY client backup for OFFLINE UC1 tuning.
# Run from the maugood repo root ON THE CLIENT. Output: uc1-collection-<ts>.tgz
#
#   bash collect-uc1.sh
#   # multi-tenant?  ->  SCHEMA=tenant_<slug> bash collect-uc1.sh
#   # whole hour     ->  MAX_CLIPS=100000 bash collect-uc1.sh
#
# Collects (scoped to the last hour where it makes sense):
#   1 decrypted sample clips                (test input)
#   2 host CPU/RAM/disk + ~40s docker stats (target + contention baseline)
#     non-secret MAUGOOD_* knobs + worker count
#   3 backend logs (last hour) + on-disk log files
#   4 DB config dump (cameras, tenant_settings) + last-hour activity CSVs
#   5 decrypted face embeddings -> embeddings.npz  (for offline matching tests)
#   6 YOLO model file /data/models/*.pt            (detector parity)
#
# SECURITY / PII:
#   * Master Fernet key NEVER leaves the box (clips + embeddings decrypted here).
#   * Tarball holds decrypted faces + biometric embeddings (PII). Keep secure,
#     NEVER push to GitHub, delete after testing.
#   * Secrets are redacted from knobs; a defensive scan runs at the end.
# ---------------------------------------------------------------------------
set -uo pipefail   # NOT -e: one failed step must not abort the whole backup

# ---- config (override via env) --------------------------------------------
WINDOW_MIN="${WINDOW_MIN:-60}"
MAX_CLIPS="${MAX_CLIPS:-40}"       # cap decrypted clips; set 100000 for the whole hour
SCHEMA="${SCHEMA:-main}"           # 'main' single-tenant, else tenant_<slug>
DB_USER="${DB_USER:-maugood}"
DB_NAME="${DB_NAME:-maugood}"
BACKEND_SVC="${BACKEND_SVC:-backend}"
PG_SVC="${PG_SVC:-}"               # auto-detected if empty

TS="$(date +%Y%m%d-%H%M%S)"
OUT="uc1-collection-${TS}"
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

log "=================================================================="
log " collect-uc1 (LAST-DAY backup) | $DC"
log " backend=$BACKEND_SVC pg=$PG_SVC schema=$SCHEMA window=${WINDOW_MIN}m max_clips=$MAX_CLIPS"
log "=================================================================="
echo
echo "  ▶▶ NOW: in the Maugood UI open a slow clip and click 'Reprocess clip'"
echo "     so this run captures real detector load. Continuing in 3s…"
echo
sleep 3

# ---- TIER 1: decrypt last-hour sample clips (key stays on box) ------------
log "TIER1: decrypting clips from last ${WINDOW_MIN}m (max ${MAX_CLIPS})…"
$DC exec -T -e WMIN="$WINDOW_MIN" -e MAXC="$MAX_CLIPS" "$BACKEND_SVC" python - <<'PY' 2>>"$LOG"
import os, glob, time
from pathlib import Path
from maugood.config import get_settings
from maugood.employees.photos import decrypt_bytes
root = get_settings().clip_storage_root
wmin = int(os.environ.get("WMIN", "60")); maxc = int(os.environ.get("MAXC", "40"))
cutoff = time.time() - wmin * 60
out = Path("/tmp/uc1col/clips"); out.mkdir(parents=True, exist_ok=True)
files = [f for f in glob.glob(f"{root}/**/*.mp4", recursive=True) if os.path.getmtime(f) >= cutoff]
files.sort(key=os.path.getmtime, reverse=True)
print(f"found {len(files)} clip(s) in last {wmin}m under {root}; decrypting up to {maxc}")
for i, f in enumerate(files[:maxc]):
    try:
        (out / f"clip_{i:03d}.mp4").write_bytes(decrypt_bytes(Path(f).read_bytes()))
        print("ok", os.path.basename(f))
    except Exception as e:
        print("skip", os.path.basename(f), type(e).__name__)
(out / "_all_lasthour_paths.txt").write_text("\n".join(files))
PY

# ---- TIER 2: host spec + load snapshot + knobs + workers ------------------
log "TIER2: host spec…"
{ echo "## lscpu"; lscpu; echo; echo "## nproc"; nproc; echo; echo "## free -h"; free -h; echo; echo "## df -h"; df -h; } > "$OUT/host-spec.txt" 2>&1

log "TIER2: docker stats (~40s, background)…"
( for _ in $(seq 8); do docker stats --no-stream 2>/dev/null; echo "----- $(date +%H:%M:%S)"; sleep 5; done ) > "$OUT/load.txt" 2>&1 &
STATS_PID=$!

log "TIER2: perf knobs (secrets redacted)…"
$DC exec -T "$BACKEND_SVC" env 2>/dev/null \
  | grep -E '^MAUGOOD_' | grep -viE 'KEY|SECRET|PASSWORD|TOKEN|FERNET|_URL|DSN|HASH' \
  | sort > "$OUT/knobs.txt" || true

log "TIER2: active capture workers…"
$DC exec -T "$BACKEND_SVC" python -c \
  "from maugood.capture.manager import capture_manager as m; print('active_workers', len(m.workers_snapshot()))" \
  > "$OUT/workers.txt" 2>>"$LOG" || true

# ---- TIER 3: logs ---------------------------------------------------------
log "TIER3: backend logs (last ${WINDOW_MIN}m)…"
$DC logs --since "${WINDOW_MIN}m" "$BACKEND_SVC" > "$OUT/backend.log" 2>&1 || true
grep -iE "reprocess detect|uc1 save|uc2 |extract|motion|detect_lock|contention|matcher|error|traceback" \
  "$OUT/backend.log" > "$OUT/backend-relevant.log" 2>/dev/null || true
$DC cp "$BACKEND_SVC:/app/logs" "$OUT/backend-logs-ondisk" 2>>"$LOG" || log "  (no /app/logs on disk — skipped)"

# ---- TIER 4: DB config dump + last-hour activity CSVs ----------------------
log "TIER4: DB config dump (schema=$SCHEMA)…"
$DC exec -T "$PG_SVC" pg_dump -U "$DB_USER" -d "$DB_NAME" \
   -t "${SCHEMA}.cameras" -t "${SCHEMA}.tenant_settings" \
   > "$OUT/db-config.sql" 2>>"$LOG" \
   && log "  config dump ok" || log "  WARN: config dump failed (check SCHEMA/PG_SVC/DB_USER)"

WIN="${WINDOW_MIN} minutes"
log "TIER4: last-${WINDOW_MIN}m person_clips CSV…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "\copy (SELECT * FROM ${SCHEMA}.person_clips WHERE clip_start > now() - interval '${WIN}') TO STDOUT WITH CSV HEADER" \
  > "$OUT/person_clips_lasthour.csv" 2>>"$LOG" || log "  WARN: person_clips csv failed"

log "TIER4: last-${WINDOW_MIN}m detection_events CSV (no embeddings)…"
$DC exec -T "$PG_SVC" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "\copy (SELECT id,tenant_id,camera_id,captured_at,employee_id,confidence,track_id,face_crop_path FROM ${SCHEMA}.detection_events WHERE captured_at > now() - interval '${WIN}') TO STDOUT WITH CSV HEADER" \
  > "$OUT/detection_events_lasthour.csv" 2>>"$LOG" || log "  WARN: detection_events csv failed"

# ---- TIER 5: decrypted face embeddings -> npz (key stays on box) ----------
log "TIER5: exporting decrypted employee embeddings…"
$DC exec -T -e SCHEMA="$SCHEMA" "$BACKEND_SVC" python - <<'PY' 2>>"$LOG"
import os
import numpy as np
from sqlalchemy import select
from maugood.db import employee_photos, employees, get_engine, tenant_context
from maugood.identification.embeddings import decrypt_embedding
schema = os.environ.get("SCHEMA", "main")
out = "/tmp/uc1col"
vecs, names = {}, {}
with tenant_context(schema):
    eng = get_engine()
    with eng.begin() as conn:
        for emp_id, token in conn.execute(
            select(employee_photos.c.employee_id, employee_photos.c.embedding)
            .where(employee_photos.c.embedding.is_not(None))
        ).fetchall():
            try:
                vecs.setdefault(int(emp_id), []).append(decrypt_embedding(bytes(token)))
            except Exception as e:
                print("skip emp", emp_id, type(e).__name__)
        for eid, nm in conn.execute(select(employees.c.id, employees.c.full_name)).fetchall():
            names[int(eid)] = nm
npz = {f"emp_{eid}": np.stack(v) for eid, v in vecs.items() if v}
np.savez(f"{out}/embeddings.npz", **npz)
import json
json.dump({str(k): names.get(k, "?") for k in vecs}, open(f"{out}/embeddings_names.json", "w"))
print(f"exported {len(npz)} employees, {sum(len(v) for v in vecs.values())} vectors")
PY

# ---- TIER 6: model files (detector parity) --------------------------------
log "TIER6: model files…"
$DC exec -T "$BACKEND_SVC" sh -c 'mkdir -p /tmp/uc1col/models && cp /data/models/*.pt /tmp/uc1col/models/ 2>/dev/null; ls -la /data/models 2>/dev/null' >> "$LOG" 2>&1 || true

# ---- pull everything written container-side, once -------------------------
log "pulling container-side artifacts (clips, embeddings, models)…"
$DC cp "$BACKEND_SVC:/tmp/uc1col" "$OUT/from-container" 2>>"$LOG" \
  && log "  pulled -> $OUT/from-container" || log "  WARN: container pull failed (see collect.log)"

# ---- finalize -------------------------------------------------------------
wait "$STATS_PID" 2>/dev/null || true
log "load snapshot complete."
$DC exec -T "$BACKEND_SVC" rm -rf /tmp/uc1col 2>/dev/null || true

log "scanning bundle for accidental plaintext secrets…"
if grep -rIlE 'BEGIN [A-Z ]*PRIVATE KEY|SESSION_SECRET|[A-Z_]*PASSWORD=' "$OUT" 2>/dev/null; then
  log "  ⚠ review files listed above before sharing"
else
  log "  clean (cameras.rtsp_url_encrypted ciphertext is expected + safe)"
fi

TAR="${OUT}.tgz"
tar czf "$TAR" "$OUT" 2>/dev/null && rm -rf "$OUT"
log "=================================================================="
log " DONE → $TAR  ($(du -h "$TAR" 2>/dev/null | cut -f1))"
log "=================================================================="
echo
echo "Download: $TAR"
echo "⚠ Contains decrypted employee-face video + biometric embeddings (PII)."
echo "  Keep secure, do NOT push to GitHub, delete after offline testing."
