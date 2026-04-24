"""IoU tracker — pure logic, no OpenCV or DB dependencies.

One track_id per "person standing in front of the camera". We keep the
state minimal: last bounding box + last timestamp per track. On each
frame the analyzer hands us a list of detections; we match each to the
best existing track (greedy, tracks can't be claimed twice per frame),
or mint a new ``track_id`` when IoU is below threshold. Tracks idle for
more than ``idle_timeout_s`` are dropped on the next update.

The event emitter only writes a ``detection_events`` row when a
detection resolves to a *new* track — that keeps the events table size
bounded regardless of how long a face lingers in the frame.

PROJECT_CONTEXT §5 "Custom IoU tracker (already proven in
detection-app)" — the prototype's not vendored into this repo, so we
implement the minimal version the pilot plan spec calls for.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True, slots=True)
class Bbox:
    """Integer pixel bounding box. (x, y) is the top-left corner."""

    x: int
    y: int
    w: int
    h: int

    @property
    def area(self) -> int:
        return max(0, self.w) * max(0, self.h)


def iou(a: Bbox, b: Bbox) -> float:
    """Intersection-over-union of two boxes. Returns 0.0 if they don't overlap."""

    left = max(a.x, b.x)
    top = max(a.y, b.y)
    right = min(a.x + a.w, b.x + b.w)
    bottom = min(a.y + a.h, b.y + b.h)
    inter_w = max(0, right - left)
    inter_h = max(0, bottom - top)
    inter = inter_w * inter_h
    if inter == 0:
        return 0.0
    union = a.area + b.area - inter
    if union <= 0:
        return 0.0
    return inter / union


@dataclass
class _Track:
    track_id: str
    bbox: Bbox
    last_seen: float


@dataclass(frozen=True, slots=True)
class TrackMatch:
    """What the tracker produces per detection."""

    track_id: str
    bbox: Bbox
    is_new: bool  # True → first time we've seen this track; worth emitting an event


class IoUTracker:
    """Greedy IoU association with per-track idle expiry.

    Parameters match pilot-plan P8 defaults: IoU threshold 0.3, idle
    timeout 3.0 seconds. Both are injectable so future tuning doesn't
    require touching this file.
    """

    def __init__(
        self,
        *,
        iou_threshold: float = 0.3,
        idle_timeout_s: float = 3.0,
        id_factory: Optional[callable] = None,  # type: ignore[type-arg]
    ) -> None:
        self.iou_threshold = iou_threshold
        self.idle_timeout_s = idle_timeout_s
        self._tracks: dict[str, _Track] = {}
        # Dependency-injected id factory so tests can generate deterministic
        # ids; production path uses hex UUIDs.
        self._id_factory: callable = id_factory or (lambda: uuid.uuid4().hex)  # type: ignore[assignment]

    @property
    def active_tracks(self) -> int:
        return len(self._tracks)

    def update(self, detections: list[Bbox], ts: float) -> list[TrackMatch]:
        """Match detections to tracks; return one ``TrackMatch`` per detection."""

        self._drop_stale(ts)

        matches: list[TrackMatch] = []
        claimed: set[str] = set()

        for det in detections:
            best_id: Optional[str] = None
            best_iou = 0.0
            for tid, track in self._tracks.items():
                if tid in claimed:
                    continue
                score = iou(det, track.bbox)
                if score > best_iou:
                    best_iou = score
                    best_id = tid

            if best_id is not None and best_iou >= self.iou_threshold:
                # Continue existing track.
                self._tracks[best_id].bbox = det
                self._tracks[best_id].last_seen = ts
                claimed.add(best_id)
                matches.append(TrackMatch(track_id=best_id, bbox=det, is_new=False))
            else:
                # Mint a new track — this is what triggers a detection_events row.
                new_id = self._id_factory()
                self._tracks[new_id] = _Track(track_id=new_id, bbox=det, last_seen=ts)
                claimed.add(new_id)
                matches.append(TrackMatch(track_id=new_id, bbox=det, is_new=True))

        return matches

    def _drop_stale(self, now: float) -> None:
        expired = [
            tid
            for tid, t in self._tracks.items()
            if now - t.last_seen > self.idle_timeout_s
        ]
        for tid in expired:
            del self._tracks[tid]
