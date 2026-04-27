"""
main.py — FastAPI app (Round 1 + Round 2).

Round 1 routes:
  Cameras CRUD, stream control, events, settings.

Round 2 adds:
  Known People     CRUD enrollment, photo upload/delete
    GET    /api/known_people
    POST   /api/known_people                       (add person, no photos yet)
    POST   /api/known_people/{name}/photo          (upload one photo)
    DELETE /api/known_people/{name}                (delete person + photos)
    DELETE /api/known_people/{name}/photo/{file}   (delete one photo)
    POST   /api/known_people/reload                (rescan folder, rebuild embeddings)
    GET    /api/known_people/{name}/photo/{file}   (serve a reference photo)

  Identify
    POST   /api/identify/run                       (match events vs known people)

  Reports
    POST   /api/report/generate                    (build Excel for a date)
    GET    /api/reports                            (list generated files)
    GET    /api/report/download/{filename}         (download an XLSX)
"""

import time
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from db import init_db, get_conn, row_to_dict
from capture import CaptureManager, settings, CAPTURES_ROOT
import known_people as kp
from identify import identify_events
from report import (
    generate_report, generate_attendance_report,
    list_reports as list_report_files, REPORTS_DIR,
)


CORS_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:3000", "http://127.0.0.1:3000",
]

manager = CaptureManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield
    manager.stop_current()


app = FastAPI(
    title="IP Camera Detection — Round 1",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Schemas
# ============================================================
class CameraIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    url: str = Field(..., min_length=1)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("name cannot be empty")
        # Disallow path-unsafe chars so camera name can be used in folder paths
        bad = set('/\\:*?"<>|')
        if any(c in bad for c in v):
            raise ValueError(f"name contains invalid characters: {sorted(bad)}")
        return v


class CameraOut(BaseModel):
    id: int
    name: str
    url: str
    enabled: bool
    created_at: str


class StreamStartRequest(BaseModel):
    camera_id: int


class SettingsIn(BaseModel):
    detector_mode: Optional[str] = None
    show_body_boxes: Optional[bool] = None
    det_size: Optional[int] = None

    @field_validator("detector_mode")
    @classmethod
    def validate_mode(cls, v):
        if v is None:
            return v
        if v not in ("insightface", "yolo+face"):
            raise ValueError("detector_mode must be 'insightface' or 'yolo+face'")
        return v

    @field_validator("det_size")
    @classmethod
    def validate_det_size(cls, v):
        if v is None:
            return v
        if v not in (160, 224, 320, 480, 640):
            raise ValueError("det_size must be one of 160, 224, 320, 480, 640")
        return v


# ============================================================
# Cameras CRUD
# ============================================================
@app.get("/api/cameras", response_model=list[CameraOut])
def list_cameras():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, url, enabled, created_at FROM cameras ORDER BY id"
        ).fetchall()
    return [{"id": r["id"], "name": r["name"], "url": r["url"],
             "enabled": bool(r["enabled"]), "created_at": r["created_at"]}
            for r in rows]


@app.post("/api/cameras", response_model=CameraOut, status_code=201)
def create_camera(body: CameraIn):
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM cameras WHERE name = ?",
                                (body.name,)).fetchone()
        if existing:
            raise HTTPException(409, "camera name already exists")
        cur = conn.execute(
            "INSERT INTO cameras (name, url, enabled) VALUES (?, ?, ?)",
            (body.name, body.url, 1 if body.enabled else 0),
        )
        new_id = cur.lastrowid
        row = conn.execute(
            "SELECT id, name, url, enabled, created_at FROM cameras WHERE id = ?",
            (new_id,),
        ).fetchone()
    return {"id": row["id"], "name": row["name"], "url": row["url"],
            "enabled": bool(row["enabled"]), "created_at": row["created_at"]}


@app.put("/api/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, body: CameraIn):
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM cameras WHERE id = ?",
                                (camera_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "camera not found")

        # Name uniqueness check (allow keeping same name)
        conflict = conn.execute(
            "SELECT id FROM cameras WHERE name = ? AND id != ?",
            (body.name, camera_id),
        ).fetchone()
        if conflict:
            raise HTTPException(409, "camera name already exists")

        conn.execute(
            "UPDATE cameras SET name = ?, url = ?, enabled = ? WHERE id = ?",
            (body.name, body.url, 1 if body.enabled else 0, camera_id),
        )
        row = conn.execute(
            "SELECT id, name, url, enabled, created_at FROM cameras WHERE id = ?",
            (camera_id,),
        ).fetchone()

    # If this was the currently-streaming camera, restart to pick up changes
    if manager.current_camera_id() == camera_id:
        manager.stop_current()

    return {"id": row["id"], "name": row["name"], "url": row["url"],
            "enabled": bool(row["enabled"]), "created_at": row["created_at"]}


@app.delete("/api/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int):
    # If this camera is currently streaming, stop it
    if manager.current_camera_id() == camera_id:
        manager.stop_current()

    with get_conn() as conn:
        cur = conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "camera not found")
    return None


# ============================================================
# Stream control
# ============================================================
@app.post("/api/stream/start")
def start_stream(body: StreamStartRequest):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, name, url, enabled FROM cameras WHERE id = ?",
            (body.camera_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "camera not found")
    if not row["enabled"]:
        raise HTTPException(400, "camera is disabled — enable it first")

    result = manager.start_camera(row["id"], row["name"], row["url"])
    # Give the worker a moment to attempt RTSP open so we can surface failures
    time.sleep(1.2)
    state = manager.get_state()
    return {**result, "state": state}


@app.post("/api/stream/stop")
def stop_stream():
    return manager.stop_current()


@app.get("/api/stream/status")
def stream_status():
    return manager.get_state()


@app.get("/api/stream/preview")
def stream_preview():
    """MJPEG multipart stream of the currently active camera."""
    def generate():
        boundary = b"--frame"
        # Keep yielding until the worker stops producing frames
        idle_ticks = 0
        while True:
            frame = manager.get_preview()
            if frame is None:
                idle_ticks += 1
                if idle_ticks > 100:   # ~5 seconds of no frames → stop
                    break
                time.sleep(0.05)
                continue
            idle_ticks = 0
            yield boundary + b"\r\n"
            yield b"Content-Type: image/jpeg\r\n"
            yield f"Content-Length: {len(frame)}\r\n\r\n".encode()
            yield frame + b"\r\n"
            time.sleep(0.04)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ============================================================
# Events
# ============================================================
@app.get("/api/events")
def list_events(
    date: Optional[str] = None,
    camera_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
):
    where, params = [], []
    if date:
        where.append("date = ?"); params.append(date)
    if camera_id:
        where.append("camera_id = ?"); params.append(camera_id)

    sql = """
        SELECT id, camera_id, camera_name, started_at, ended_at, date,
               duration_sec, frames_seen, faces_saved, max_duration_hit,
               person_name, match_score, folder
        FROM events
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        # For each event find the best face id for thumbnail
        events = []
        for r in rows:
            best = conn.execute(
                """SELECT id, file_path FROM faces
                   WHERE event_id = ? ORDER BY quality DESC LIMIT 1""",
                (r["id"],),
            ).fetchone()
            events.append({
                "id": r["id"],
                "camera_id": r["camera_id"],
                "camera_name": r["camera_name"],
                "started_at": r["started_at"],
                "ended_at": r["ended_at"],
                "date": r["date"],
                "duration_sec": r["duration_sec"],
                "frames_seen": r["frames_seen"],
                "faces_saved": r["faces_saved"],
                "max_duration_hit": bool(r["max_duration_hit"]),
                "person_name": r["person_name"],
                "match_score": r["match_score"],
                "best_face_id": best["id"] if best else None,
                "best_face_url": f"/api/face/{best['id']}" if best else None,
            })
    return {"events": events, "limit": limit, "offset": offset}


@app.get("/api/events/{event_id}")
def get_event(event_id: int):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT id, camera_id, camera_name, started_at, ended_at, date,
                      duration_sec, frames_seen, faces_saved, max_duration_hit,
                      person_name, match_score, folder
               FROM events WHERE id = ?""",
            (event_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "event not found")
        faces = conn.execute(
            """SELECT id, quality, det_score, face_width, face_height, created_at
               FROM faces WHERE event_id = ? ORDER BY quality DESC""",
            (event_id,),
        ).fetchall()

    event = dict(row)
    event["max_duration_hit"] = bool(event["max_duration_hit"])
    event["faces"] = [
        {
            "id": f["id"],
            "quality": f["quality"],
            "det_score": f["det_score"],
            "face_width": f["face_width"],
            "face_height": f["face_height"],
            "url": f"/api/face/{f['id']}",
        }
        for f in faces
    ]
    return event


@app.get("/api/face/{face_id}")
def get_face_file(face_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT file_path FROM faces WHERE id = ?", (face_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "face not found")
    path = Path(row["file_path"])
    if not path.exists():
        raise HTTPException(410, "file no longer exists on disk")
    return FileResponse(path, media_type="image/jpeg")


# ============================================================
# Settings
# ============================================================
@app.get("/api/settings")
def get_settings():
    return settings.to_dict()


@app.put("/api/settings")
def update_settings(body: SettingsIn):
    if body.detector_mode is not None:
        settings.set_mode(body.detector_mode)
    if body.show_body_boxes is not None:
        settings.set_show_body_boxes(body.show_body_boxes)
    if body.det_size is not None:
        settings.set_det_size(body.det_size)
    return settings.to_dict()


# ============================================================
# Round 2: Job tracker
# ============================================================
# Lightweight in-memory job registry for long-running tasks (identify, report).
# Keeps the UI responsive — POST returns a job_id instantly, UI polls /api/jobs/{id}.
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def _new_job(kind: str) -> str:
    jid = uuid.uuid4().hex[:8]
    with _jobs_lock:
        _jobs[jid] = {
            "id": jid, "kind": kind, "status": "queued",
            "started_at": None, "finished_at": None,
            "progress": None, "result": None, "error": None,
        }
        # Prune so the dict doesn't grow forever
        if len(_jobs) > 50:
            oldest = sorted(
                _jobs.items(),
                key=lambda kv: kv[1].get("finished_at") or kv[1].get("started_at") or 0,
            )
            for k, _ in oldest[:len(_jobs) - 50]:
                _jobs.pop(k, None)
    return jid


def _update_job(jid: str, **updates):
    with _jobs_lock:
        if jid in _jobs:
            _jobs[jid].update(updates)


@app.get("/api/jobs")
def list_jobs():
    with _jobs_lock:
        items = sorted(
            _jobs.values(),
            key=lambda j: j.get("started_at") or 0, reverse=True,
        )
    return {"jobs": items[:20]}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with _jobs_lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j


# ============================================================
# Round 2: Known people
# ============================================================
class KnownPersonCreate(BaseModel):
    name: str


@app.get("/api/known_people")
def list_known_people():
    return {
        "people": kp.cache.list_people(),
        "folder": str(kp.KNOWN_DIR.resolve()),
    }


@app.post("/api/known_people", status_code=201)
def create_known_person(body: KnownPersonCreate):
    try:
        pdir = kp.person_dir(body.name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if pdir.exists():
        raise HTTPException(409, "person already exists")
    pdir.mkdir(parents=True)
    return {"ok": True, "name": body.name}


@app.post("/api/known_people/{name}/photo", status_code=201)
async def upload_photo(name: str, file: UploadFile = File(...)):
    try:
        kp._safe_name(name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    content = await file.read()
    if not content:
        raise HTTPException(400, "empty file")
    # Basic size guard — 10MB per photo
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "file too large (max 10MB)")
    saved = kp.save_photo(name, content, file.filename or "photo.jpg")
    # Invalidate cache so next reload picks up the new photo
    kp.cache.reload()
    return {"ok": True, "name": name, "file": saved.name}


@app.delete("/api/known_people/{name}", status_code=204)
def delete_known_person(name: str):
    try:
        kp._safe_name(name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not (kp.KNOWN_DIR / name).exists():
        raise HTTPException(404, "person not found")
    kp.delete_person(name)
    kp.cache.reload()
    return None


@app.delete("/api/known_people/{name}/photo/{filename}", status_code=204)
def delete_known_photo(name: str, filename: str):
    try:
        kp._safe_name(name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    try:
        ok = kp.delete_photo(name, filename)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not ok:
        raise HTTPException(404, "photo not found")
    kp.cache.reload()
    return None


@app.post("/api/known_people/reload")
def reload_known_people():
    stats = kp.cache.reload()
    return {"ok": True, **stats}


@app.get("/api/known_people/{name}/photo/{filename}")
def serve_known_photo(name: str, filename: str):
    try:
        kp._safe_name(name)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "bad filename")
    path = kp.KNOWN_DIR / name / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "photo not found")
    return FileResponse(path, media_type="image/jpeg")


# ============================================================
# Round 2: Identify
# ============================================================
class IdentifyRequest(BaseModel):
    date: Optional[str] = None
    reidentify: bool = False


@app.post("/api/identify/run")
def run_identify(body: IdentifyRequest):
    jid = _new_job("identify")

    def run():
        _update_job(jid, status="running", started_at=time.time())
        try:
            def progress(p, m, u):
                _update_job(jid, progress={"processed": p, "matched": m, "unknown": u})
            result = identify_events(
                date=body.date, reidentify=body.reidentify,
                progress_cb=progress,
            )
            if result.get("ok"):
                _update_job(jid, status="done", finished_at=time.time(), result=result)
            else:
                _update_job(jid, status="error", finished_at=time.time(),
                            error=result.get("error"))
        except Exception as e:
            _update_job(jid, status="error", finished_at=time.time(), error=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "job_id": jid}


# ============================================================
# Round 2: Reports
# ============================================================
class ReportRequest(BaseModel):
    date: str                         # YYYY-MM-DD
    include_unknown: bool = True
    auto_identify: bool = True        # run identify first if True

    @field_validator("date")
    @classmethod
    def validate_date(cls, v):
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError("date must be YYYY-MM-DD")
        return v


@app.post("/api/report/generate")
def run_report(body: ReportRequest):
    jid = _new_job("report")

    def run():
        _update_job(jid, status="running", started_at=time.time())
        try:
            identify_result = None
            if body.auto_identify:
                _update_job(jid, progress={"step": "identifying"})
                identify_result = identify_events(date=body.date, reidentify=False)

            _update_job(jid, progress={"step": "writing excel"})
            result = generate_report(
                date=body.date, include_unknown=body.include_unknown,
            )
            if not result.get("ok"):
                _update_job(jid, status="error", finished_at=time.time(),
                            error=result.get("error"))
                return

            combined = dict(result)
            combined["kind"] = "event"
            if identify_result:
                combined["identify"] = identify_result
            _update_job(jid, status="done", finished_at=time.time(), result=combined)
        except Exception as e:
            _update_job(jid, status="error", finished_at=time.time(), error=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "job_id": jid}


class AttendanceRequest(BaseModel):
    date: str
    auto_identify: bool = True

    @field_validator("date")
    @classmethod
    def validate_date(cls, v):
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            raise ValueError("date must be YYYY-MM-DD")
        return v


@app.post("/api/report/attendance/generate")
def run_attendance_report(body: AttendanceRequest):
    """Generate the daily attendance (in/out per person) report."""
    jid = _new_job("attendance")

    def run():
        _update_job(jid, status="running", started_at=time.time())
        try:
            identify_result = None
            if body.auto_identify:
                _update_job(jid, progress={"step": "identifying"})
                identify_result = identify_events(date=body.date, reidentify=False)

            _update_job(jid, progress={"step": "writing excel"})
            result = generate_attendance_report(date=body.date)
            if not result.get("ok"):
                _update_job(jid, status="error", finished_at=time.time(),
                            error=result.get("error"))
                return

            combined = dict(result)
            combined["kind"] = "attendance"
            if identify_result:
                combined["identify"] = identify_result
            _update_job(jid, status="done", finished_at=time.time(), result=combined)
        except Exception as e:
            _update_job(jid, status="error", finished_at=time.time(), error=str(e))

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "job_id": jid}


@app.get("/api/reports")
def list_reports():
    return {"reports": list_report_files(),
            "folder": str(REPORTS_DIR.resolve())}


@app.get("/api/report/download/{filename}")
def download_report(filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "bad filename")
    path = REPORTS_DIR / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "report not found")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )


# ============================================================
# Root
# ============================================================
@app.get("/")
def root():
    return {
        "service": "IP Camera Detection API",
        "round": 2,
        "features": [
            "cameras CRUD", "event-based capture", "settings toggle",
            "known people enrollment", "identify events", "Excel reports",
        ],
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    print(f"Captures folder: {CAPTURES_ROOT.resolve()}")
    print("API docs: http://localhost:5006/docs")
    uvicorn.run(app, host="0.0.0.0", port=5006, log_level="info")