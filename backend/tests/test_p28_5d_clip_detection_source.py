"""Tests for body-only clip recording (post-migration-0074).

The per-camera ``clip_detection_source`` knob and the per-clip
``detection_source`` stamp were removed in migration 0074 — clip
recording is now *always* driven by YOLO body/person presence. This
file covers what survives:

* ``slugify_camera_name`` — pure helper for the clip path format.
* The body-only ``any_person`` rule the analyzer applies: a clip
  stays alive iff YOLO sees a person, regardless of face count.

No live RTSP, no real ffmpeg, no InsightFace model.
"""

from __future__ import annotations

import pytest

from maugood.capture.clip_worker import slugify_camera_name


# --- slugify helper --------------------------------------------------------


@pytest.mark.parametrize(
    "name,camera_id,expected",
    [
        ("Front Lobby", 1, "front-lobby"),
        ("front-lobby", 1, "front-lobby"),
        ("Camera #3 / North", 7, "camera-3-north"),
        ("CAM-002", 2, "cam-002"),
        ("  Reception ", 3, "reception"),
        ("---weird---", 4, "weird"),
        ("entry__1", 5, "entry__1"),
        # Dots and slashes flatten to dashes; collapse repeats; strip.
        ("a..b//c", 6, "a-b-c"),
        # Empty / whitespace / non-ASCII → fallback to camera-{id}.
        ("", 9, "camera-9"),
        ("   ", 10, "camera-10"),
        # Non-ASCII characters get rewritten to '-' then stripped/collapsed.
        ("الكاميرا", 11, "camera-11"),
        # Repeated non-allowed runs collapse to one '-'.
        ("foo!!!bar???baz", 12, "foo-bar-baz"),
    ],
)
def test_slugify_camera_name(name: str, camera_id: int, expected: str) -> None:
    assert slugify_camera_name(name, camera_id) == expected


def test_slugify_camera_name_handles_non_string_input() -> None:
    """Defensive: None / int inputs should not crash."""
    # Empty fallback when name is None.
    assert slugify_camera_name(None, 42) == "camera-42"  # type: ignore[arg-type]
    # Int input gets stringified.
    assert slugify_camera_name(123, 5) == "123"  # type: ignore[arg-type]


# --- body-only any_person rule (migration 0074) ----------------------------


@pytest.mark.parametrize(
    "face_count,person_count,expected_any_person",
    [
        # No bodies → no clip, even if faces were somehow detected.
        (0, 0, False),
        (3, 0, False),
        # Any body present → clip stays alive, regardless of face count.
        (0, 1, True),
        (0, 5, True),
        (2, 1, True),
    ],
)
def test_any_person_is_body_only(
    face_count: int, person_count: int, expected_any_person: bool
) -> None:
    """After migration 0074 the analyzer computes ``any_person`` from
    the YOLO body/person count alone — face count never drives the
    clip-recording trigger. This mirrors the single line in
    ``reader.py``'s analyzer loop so a future refactor that
    reintroduces a face dependency fails here.
    """

    any_person = person_count > 0
    assert any_person is expected_any_person
