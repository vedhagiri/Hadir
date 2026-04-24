"""Pure-logic tests for the IoU tracker."""

from __future__ import annotations

from hadir.capture.tracker import Bbox, IoUTracker, iou


def test_iou_non_overlapping_is_zero() -> None:
    a = Bbox(x=0, y=0, w=10, h=10)
    b = Bbox(x=100, y=100, w=10, h=10)
    assert iou(a, b) == 0.0


def test_iou_identical_is_one() -> None:
    a = Bbox(x=0, y=0, w=20, h=20)
    assert iou(a, a) == 1.0


def test_iou_half_overlap() -> None:
    a = Bbox(x=0, y=0, w=10, h=10)
    b = Bbox(x=5, y=0, w=10, h=10)
    # Intersection 5x10=50, union 200-50=150; IoU = 50/150 = 1/3
    assert abs(iou(a, b) - 1 / 3) < 1e-9


def test_new_detection_creates_new_track() -> None:
    tr = IoUTracker()
    det = Bbox(x=10, y=10, w=50, h=50)
    matches = tr.update([det], ts=0.0)
    assert len(matches) == 1
    assert matches[0].is_new is True
    assert tr.active_tracks == 1


def test_overlapping_detection_continues_track_without_new_event() -> None:
    tr = IoUTracker(iou_threshold=0.3, idle_timeout_s=3.0)
    tr.update([Bbox(x=10, y=10, w=50, h=50)], ts=0.0)

    # Next frame, slight shift — plenty of overlap.
    matches = tr.update([Bbox(x=12, y=12, w=50, h=50)], ts=0.1)
    assert len(matches) == 1
    assert matches[0].is_new is False
    assert tr.active_tracks == 1


def test_low_overlap_starts_a_new_track() -> None:
    tr = IoUTracker(iou_threshold=0.3, idle_timeout_s=3.0)
    first = tr.update([Bbox(x=0, y=0, w=40, h=40)], ts=0.0)[0]

    # A second person appears clear across the frame.
    second = tr.update(
        [
            Bbox(x=0, y=0, w=40, h=40),      # the first track, essentially same box
            Bbox(x=300, y=200, w=40, h=40),  # new
        ],
        ts=0.1,
    )
    assert len(second) == 2
    # The continuation is first in the list (same bbox maps to first's track).
    continued = next(m for m in second if m.track_id == first.track_id)
    assert continued.is_new is False
    other = next(m for m in second if m.track_id != first.track_id)
    assert other.is_new is True
    assert tr.active_tracks == 2


def test_idle_track_expires_and_new_event_emits() -> None:
    tr = IoUTracker(iou_threshold=0.3, idle_timeout_s=1.0)
    first = tr.update([Bbox(x=10, y=10, w=50, h=50)], ts=0.0)[0]
    assert first.is_new

    # No detections for 2 seconds — track should be gone.
    tr.update([], ts=2.0)
    assert tr.active_tracks == 0

    # Same bbox reappears. Because the previous track expired, this
    # is treated as a brand-new track (new track_id, is_new=True).
    again = tr.update([Bbox(x=10, y=10, w=50, h=50)], ts=2.5)[0]
    assert again.is_new is True
    assert again.track_id != first.track_id


def test_no_double_claim_on_same_frame() -> None:
    """Two detections in one frame must not both resolve to the same track."""

    tr = IoUTracker(iou_threshold=0.3, idle_timeout_s=3.0)
    tr.update([Bbox(x=10, y=10, w=50, h=50)], ts=0.0)

    # Two detections; both overlap the existing track's last position,
    # but only one should continue it. The second must start a fresh
    # track (is_new=True).
    matches = tr.update(
        [
            Bbox(x=12, y=12, w=50, h=50),
            Bbox(x=14, y=14, w=50, h=50),
        ],
        ts=0.2,
    )
    assert sum(1 for m in matches if m.is_new) == 1
    assert sum(1 for m in matches if not m.is_new) == 1
    assert tr.active_tracks == 2
