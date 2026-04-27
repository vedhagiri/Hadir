"""
db.py — SQLite helpers shared by all backend modules.

Schema:
  cameras       one row per configured camera (CRUD target)
  events        one row per person-appearance (grouped detections)
  faces         one row per saved face crop, references an event
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path("app.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    url          TEXT    NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id     INTEGER NOT NULL,
    camera_name   TEXT    NOT NULL,   -- denormalized so deleting camera keeps history
    folder        TEXT    NOT NULL,   -- relative path to event folder
    started_at    TEXT    NOT NULL,   -- ISO timestamp
    ended_at      TEXT,
    date          TEXT    NOT NULL,   -- YYYY-MM-DD, for fast filtering
    frames_seen   INTEGER NOT NULL DEFAULT 0,
    faces_saved   INTEGER NOT NULL DEFAULT 0,
    duration_sec  REAL,
    max_duration_hit INTEGER NOT NULL DEFAULT 0,
    person_name   TEXT,                -- filled by identify.py (Round 2)
    match_score   REAL,
    FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_date   ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id);
CREATE INDEX IF NOT EXISTS idx_events_person ON events(person_name);

CREATE TABLE IF NOT EXISTS faces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    file_path    TEXT    NOT NULL,
    quality      REAL    NOT NULL,    -- composite quality score (bigger = better)
    det_score    REAL,
    face_width   INTEGER,
    face_height  INTEGER,
    embedding    BLOB,                -- float32 bytes, set by InsightFace
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_faces_event ON faces(event_id);
CREATE INDEX IF NOT EXISTS idx_faces_quality ON faces(quality DESC);
"""


def init_db(db_path: Path = DB_PATH) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.executescript(SCHEMA)


@contextmanager
def get_conn(db_path: Path = DB_PATH):
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row) -> dict:
    return {k: row[k] for k in row.keys()} if row else None