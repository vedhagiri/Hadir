"""
tracker.py — simple IoU-based tracker.

One Track object per active person. Each incoming frame of detections is
matched to existing tracks by IoU; unmatched detections start new tracks;
tracks with no match for `timeout_sec` are retired.

Good enough for a few people walking through a camera view. For dense
crowds or crossing paths, a Kalman-based tracker (ByteTrack/DeepSORT)
would do better, but those pull in more dependencies for marginal gain
at the scales we care about.
"""

import time
import itertools
from dataclasses import dataclass, field
from typing import Optional


def iou(a: tuple, b: tuple) -> float:
    """IoU between two (x1,y1,x2,y2) boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


@dataclass
class Track:
    id: int
    bbox: tuple                # last known bbox
    started_at: float          # wall-clock timestamp (time.time())
    last_seen_at: float
    hits: int = 1              # number of frames matched
    event_id: Optional[int] = None   # filled by capture.py once event row is created
    folder: Optional[str] = None     # path to event folder on disk
    faces_saved: int = 0
    max_duration_hit: bool = False   # set True once we stop saving due to 60s cap

    @property
    def duration_sec(self) -> float:
        return self.last_seen_at - self.started_at


class IoUTracker:
    """
    Parameters:
      iou_threshold     minimum IoU for a detection to match an existing track
      timeout_sec       track is retired if no match for this many seconds
      max_duration_sec  stop saving new faces after a track lives this long
                        (still matches to the existing track — we just stop
                        accumulating data, per the "person standing too long"
                        requirement)
    """

    def __init__(self,
                 iou_threshold: float = 0.3,
                 timeout_sec: float = 2.0,
                 max_duration_sec: float = 60.0):
        self.iou_threshold = iou_threshold
        self.timeout_sec = timeout_sec
        self.max_duration_sec = max_duration_sec
        self._id_counter = itertools.count(1)
        self.tracks: dict[int, Track] = {}

    def update(self, detections: list[dict], now: float = None) -> list[tuple[Track, dict]]:
        """
        Match detections to tracks.
        Returns list of (track, detection) pairs, one per detection.
        Detections that started a new track have a brand-new Track.
        Also updates retired tracks internally.
        """
        if now is None:
            now = time.time()

        # Greedy IoU matching: for each detection, find the track with
        # highest IoU above threshold. A track can only be claimed once.
        claimed_track_ids = set()
        pairs: list[tuple[Track, dict]] = []

        # Sort detections by area (larger first) so bigger detections
        # get first pick of existing tracks
        dets_by_size = sorted(
            enumerate(detections),
            key=lambda item: -((item[1]["bbox"][2] - item[1]["bbox"][0]) *
                               (item[1]["bbox"][3] - item[1]["bbox"][1])),
        )

        for _, det in dets_by_size:
            best_iou = 0.0
            best_tid = None
            for tid, track in self.tracks.items():
                if tid in claimed_track_ids:
                    continue
                i = iou(det["bbox"], track.bbox)
                if i > best_iou:
                    best_iou = i
                    best_tid = tid
            if best_tid is not None and best_iou >= self.iou_threshold:
                track = self.tracks[best_tid]
                track.bbox = det["bbox"]
                track.last_seen_at = now
                track.hits += 1
                claimed_track_ids.add(best_tid)
                # Mark max-duration reached (capture.py reads this flag)
                if track.duration_sec >= self.max_duration_sec:
                    track.max_duration_hit = True
                pairs.append((track, det))
            else:
                # New track
                new_id = next(self._id_counter)
                track = Track(id=new_id, bbox=det["bbox"],
                              started_at=now, last_seen_at=now)
                self.tracks[new_id] = track
                pairs.append((track, det))

        return pairs

    def retire_expired(self, now: float = None) -> list[Track]:
        """Remove tracks that haven't been seen for `timeout_sec`. Returns the retired tracks."""
        if now is None:
            now = time.time()
        retired = []
        for tid in list(self.tracks.keys()):
            track = self.tracks[tid]
            if now - track.last_seen_at > self.timeout_sec:
                retired.append(track)
                del self.tracks[tid]
        return retired

    def retire_all(self) -> list[Track]:
        """Retire every track — used on shutdown to close open events."""
        retired = list(self.tracks.values())
        self.tracks.clear()
        return retired