#!/usr/bin/env bash
# A/B frame-pipeline test on Inaisys Office (tenant 2, camera 1).
# Phase A: YOLO ON + clip OFF.  Phase B: YOLO ON + clip ON (stream_copy).
# Outputs to a persistent dir (survives /tmp wipe / reboot). Samples every 20s.
set -u
BASE="http://localhost:8000"
OUT=/home/hari-inaisys/Omran/Hadir/issues/ab_test
J="$OUT/cookies.txt"
CAM=1
PHASE_SECS=600
STEP=20
mkdir -p "$OUT"
CSV="$OUT/samples.csv"
LOG="$OUT/run.log"
if [ ! -f "$CSV" ]; then
  echo "phase,iso_ts,epoch,uptime_s,status,fps_reader,fps_analyzer,frames_analyzed_60s,motion_skipped_60s,detection_detail,host_cpu_overall,host_mem_pct,host_mem_used_gb,py_cpu,py_rss_gb,ffmpeg_n,ffmpeg_cpu_sum" > "$CSV"
fi
: > "$LOG"
log(){ echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

auth(){ curl -s -m10 -c "$J" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"harikrishnan@inaisys.co","password":"Hari@123","tenant_slug":"inaisys"}' >/dev/null; }

auth
curl -s -m10 -b "$J" -X POST "$BASE/api/diagnostics/clear" >/dev/null
curl -s -m10 -b "$J" -X POST "$BASE/api/diagnostics/start" >/dev/null
log "diagnostics recorder enabled; boot uptime=$(awk '{print int($1)}' /proc/uptime)s"

sample(){
  local phase="$1" w sn iso epoch up fn fc pcpu prss
  iso=$(date -u +%Y-%m-%dT%H:%M:%SZ); epoch=$(date +%s); up=$(awk '{print int($1)}' /proc/uptime)
  w=$(curl -s -m10 -b "$J" "$BASE/api/operations/workers")
  # re-auth if unauthorized (backend may have restarted)
  if echo "$w" | grep -q '"detail"'; then auth; w=$(curl -s -m10 -b "$J" "$BASE/api/operations/workers"); fi
  sn=$(curl -s -m10 -b "$J" "$BASE/api/diagnostics/system-snapshot")
  fn=$(ps -eo comm | grep -c '^ffmpeg$')
  fc=$(ps -eo pcpu,comm | awk '$2=="ffmpeg"{s+=$1} END{printf "%.1f",s}')
  pcpu=$(ps -eo pcpu,comm | awk '$2=="python3.11"{s+=$1} END{printf "%.0f",s}')
  prss=$(ps -eo rss,comm | awk '$2=="python3.11"{s+=$1} END{printf "%.2f",s/1024/1024}')
  CAM="$CAM" PHASE="$phase" ISO="$iso" EPOCH="$epoch" UP="$up" FN="$fn" FC="$fc" PCPU="$pcpu" PRSS="$prss" \
  python3 - "$w" "$sn" <<'PY' >> "$CSV"
import json,os,sys
w=json.loads(sys.argv[1]) if sys.argv[1] else {}
sn=json.loads(sys.argv[2]) if sys.argv[2] else {}
cam=int(os.environ["CAM"]); row=None
for x in (w.get("workers",[]) if isinstance(w,dict) else []):
    if int(x.get("camera_id") or 0)==cam: row=x;break
def g(d,k,dv=""):
    v=d.get(k) if d else None
    return dv if v is None else v
det=str(((row.get("stages") or {}).get("detection") or {}).get("detail","") if row else "").replace(","," ").replace("\n"," ")
print(",".join(str(x) for x in [os.environ["PHASE"],os.environ["ISO"],os.environ["EPOCH"],os.environ["UP"],
  g(row,"status","na"),g(row,"fps_reader",0),g(row,"fps_analyzer",0),
  g(row,"frames_analyzed_60s",0),g(row,"frames_motion_skipped_60s",0),det,
  g(sn,"host_cpu_percent_overall",0),g(sn,"host_memory_percent",0),g(sn,"host_memory_used_gb",0),
  os.environ["PCPU"],os.environ["PRSS"],os.environ["FN"],os.environ["FC"]]))
PY
}

run_phase(){
  local phase="$1" secs="$2" end; end=$(( $(date +%s) + secs ))
  log "PHASE $phase start (${secs}s)"
  while [ "$(date +%s)" -lt "$end" ]; do sample "$phase"; sleep "$STEP"; done
  log "PHASE $phase done"
}

curl -s -m10 -b "$J" -X PATCH "$BASE/api/cameras/$CAM" -H 'Content-Type: application/json' \
  -d '{"clip_recording_enabled":false}' >/dev/null
log "clip=false (Phase A)"; sleep 5
run_phase "A_clipOFF" "$PHASE_SECS"

curl -s -m10 -b "$J" -X PATCH "$BASE/api/cameras/$CAM" -H 'Content-Type: application/json' \
  -d '{"clip_recording_enabled":true}' >/dev/null
log "clip=true (Phase B)"; sleep 5
run_phase "B_clipON" "$PHASE_SECS"

curl -s -m10 -b "$J" -X PATCH "$BASE/api/cameras/$CAM" -H 'Content-Type: application/json' \
  -d '{"clip_recording_enabled":false}' >/dev/null
log "restored clip=false"
curl -s -m15 -b "$J" "$BASE/api/diagnostics/events?kind=fps_drop&limit=500" > "$OUT/fps_drop_events.json"
curl -s -m15 -b "$J" -X POST "$BASE/api/diagnostics/stop" >/dev/null
log "DONE"
