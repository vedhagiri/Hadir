# IP Camera Detection — Round 1

Multi-camera face detection with event-based tracking. FastAPI backend +
React frontend. Cameras are managed through the UI, and detections are
grouped into "events" (one person-appearance = one event) with the best
face crops saved per event.

**Round 1 scope:** cameras CRUD, event-based capture, settings panel.
**Round 2 (next):** known-people enrollment, end-of-day identification,
Excel report generation.

## Architecture

```
┌──────────────────────┐       ┌──────────────────────┐       ┌────────────┐
│  React (port 5173)   │◀─────▶│  FastAPI (5006)      │──RTSP▶│  Cameras   │
│                      │       │                      │       │            │
│  • CameraList        │ REST  │  • cameras table     │       │  CP Plus,  │
│  • Live preview      │       │  • CaptureManager    │       │  Hikvision │
│  • EventsList        │       │  • IoU tracker       │       │  etc.      │
│  • EventDetail modal │       │  • Best-N face saver │       │            │
└──────────────────────┘       └──────────┬───────────┘       └────────────┘
                                          │
                                          ▼
                                     app.db (SQLite)
                                     captures/<date>/<camera>/<event>/
```

## What makes this different from the original Flask version

| Original | Round 1 |
|---|---|
| Scatter-shot saves every 3s | **Event-based**: one event per person appearance, 10 best faces per event |
| No concept of "same person" between frames | **IoU tracker** groups consecutive detections |
| Saves bodies (YOLO) | Saves **faces** (InsightFace) — required for identification |
| Person loiters → 100s of near-dupes | **60s cap** per event — save best 10 then stop |
| One hardcoded camera | **Multi-camera CRUD** with per-camera events and tagging |
| Monolithic Flask file | FastAPI + React, component-based |

## Quick start

Two terminals.

**Terminal 1 — backend:**
```bash
cd backend
pip install -r requirements.txt
python main.py
```

First run downloads the InsightFace model (~300 MB) to `~/.insightface/`. One-time.

Backend at `http://localhost:5006`. Docs at `http://localhost:5006/docs`.

**Terminal 2 — frontend:**
```bash
cd frontend
npm install
npm run dev
```

UI at `http://localhost:5173`.

## Project structure

```
detection-app/
├── backend/
│   ├── main.py            # FastAPI app, all routes
│   ├── db.py              # SQLite schema (cameras / events / faces)
│   ├── detectors.py       # InsightFace + YOLO+face, runtime-switchable
│   ├── tracker.py         # IoU tracker
│   ├── capture.py         # CameraWorker + CaptureManager
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx              # entry
        ├── App.jsx               # top-level layout
        ├── api.js                # all fetch calls
        ├── config.js             # API_BASE
        ├── styles.css
        ├── hooks/
        │   └── usePolling.js
        └── components/
            ├── CameraList.jsx    # list + select + edit/delete
            ├── CameraForm.jsx    # add/edit modal
            ├── VideoView.jsx     # MJPEG <img>
            ├── StatusBar.jsx     # capture stats pills
            ├── SettingsPanel.jsx # detector toggle
            ├── EventsList.jsx    # event cards grid
            └── EventDetail.jsx   # event detail modal
```

## Using it

### 1. Add cameras

Click **Add camera** → name + RTSP URL → Save. Cameras persist across
restarts (stored in `app.db`).

CP Plus URL formats:
- Main: `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=0`
- Sub:  `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=1` *(recommended)*
- Some firmware: `rtsp://user:pass@IP:554/video/live?channel=1&subtype=0`

Test the URL in VLC first if you're unsure.

### 2. Start capture

Click a camera in the list. The live preview appears on the right.
Green boxes = actively saving, yellow = max duration hit (person loitering).

Click the same camera again, or **Stop stream**, to stop it.
Only one camera streams at a time per your requirement.

### 3. Watch events form

As people walk past, events appear in the **Events** grid below. Each
card shows the best face captured, start time, duration, and face count.

Click an event card to see all saved faces in a modal, plus metadata
(camera, start/end time, max-duration flag, folder path).

### 4. Switch detector

The **Detector** panel lets you toggle between:
- **InsightFace** (default): full-frame face detection. Simpler.
- **YOLO + Face**: finds people first, then detects faces inside each body.
  Useful if the camera has lots of background and you want to skip the
  non-person regions.

Changes take effect on the next processed frame. No restart needed.

## Event lifecycle

1. A face is detected that doesn't match any active track → new event row in DB
   + event folder on disk.
2. Each subsequent frame with a matching detection:
   - Compute a quality score (size × pose × confidence).
   - If event has fewer than 10 faces saved → save.
   - Else compare to worst-saved face → replace if better.
3. When track hits 60s duration → flag `max_duration_hit`, stop saving new
   faces (but keep the event alive so we don't start a new one on position
   shifts).
4. When track has no matches for 2 seconds → close event: update `ended_at`,
   `duration_sec`, write `meta.json` in the folder.

## Disk layout

```
captures/
└── 2026-04-20/
    └── Front_Door/
        ├── event_000001_073215/
        │   ├── face_01_q0.87.jpg
        │   ├── face_02_q0.82.jpg
        │   ├── ...
        │   └── meta.json
        └── event_000002_074530/
            └── ...
```

Each event folder is self-contained — cleanup is as simple as
`rm -rf captures/2026-04-13/` for a week-old day.

## API reference

All endpoints documented interactively at `http://localhost:5006/docs`.

```
GET    /api/cameras              list all cameras
POST   /api/cameras              create (body: {name, url, enabled})
PUT    /api/cameras/{id}         update
DELETE /api/cameras/{id}         delete

POST   /api/stream/start         start capture (body: {camera_id})
POST   /api/stream/stop          stop
GET    /api/stream/status        {running, camera_id, stats}
GET    /api/stream/preview       MJPEG stream of current camera

GET    /api/events               list events with filters
GET    /api/events/{id}          single event + all its faces
GET    /api/face/{face_id}       serve face JPEG

GET    /api/settings             current detector mode
PUT    /api/settings             change detector mode
```

## What's coming in Round 2

- `known_people/` management (UI upload + manual folder)
- `identify.py` script — match every event's best faces against known
  people embeddings, write `person_name` into `events` table
- Report generator — Excel file with one row per identified appearance
  (columns: camera name, date, time, person, reference photo, embedded
  thumbnail)
- One-click download button in the UI with date picker

The DB schema already has `person_name` and `match_score` columns waiting
to be filled in — Round 2 adds the logic that populates them.

## Security

- The backend has no authentication. Bind to `127.0.0.1` only (default)
  or put it behind a reverse proxy if you need LAN access.
- Camera passwords live in the SQLite file in plaintext. Restrict perms:
  `chmod 600 app.db`.
- Face crops are biometric data. Don't leave them publicly accessible.