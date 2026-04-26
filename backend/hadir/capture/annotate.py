"""Bounding-box drawing for the Live Capture viewer (P28.5).

Boxes are drawn into the BGR frame *before* JPEG-encoding so the
frontend can stream the result straight to ``<img>`` — no canvas
overlay, no client-side coordinate math. Colour conventions match
the design tokens used by the static demo's bbox classes:

* ``id-known``   → green   (BGR ``(74, 222, 128)``  ≈ ``#4ade80``)
* ``id-unknown`` → amber   (BGR ``(21, 204, 250)`` ≈ ``#facc15``)

Pure CPU work — no DB, no IO. Modifies ``frame_bgr`` in place; the
caller hands us the same array it just received from
``cv2.VideoCapture.read``. Returning the array would imply a copy.

Tuning: stroke=2px, font=HERSHEY_SIMPLEX scale 0.5; both legible
on a 1280×720 frame at 10 fps in the browser without dominating
the picture. JPEG encoding happens in the caller — keeping draw
and encode separate lets tests assert on the annotated array.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional


# OpenCV uses BGR. RGB hex equivalents are noted for cross-reference
# with the design tokens in styles.css.
_GREEN_BGR = (128, 222, 74)   # #4ade80 (success)
_AMBER_BGR = (21, 204, 250)   # #facc15 (warning)
_BLACK_BGR = (0, 0, 0)
_WHITE_BGR = (255, 255, 255)


@dataclass(frozen=True, slots=True)
class AnnotationBox:
    """One box to draw on the frame.

    ``label`` is the text rendered above the box (employee name +
    confidence, or ``"Unknown"``); ``known`` picks the colour.
    """

    x: int
    y: int
    w: int
    h: int
    label: str
    known: bool


def annotate_frame(frame_bgr, boxes: Iterable[AnnotationBox]) -> None:  # type: ignore[no-untyped-def]
    """Draw every box onto ``frame_bgr`` in place.

    Boxes outside the frame are clipped to the image bounds before
    drawing so OpenCV doesn't raise on negative coords. The label
    rectangle hugs the top-left corner of the box; if there isn't
    enough space above the box, it falls inside instead.
    """

    import cv2  # noqa: PLC0415

    h_frame, w_frame = frame_bgr.shape[:2]

    for b in boxes:
        x1 = max(0, min(w_frame - 1, int(b.x)))
        y1 = max(0, min(h_frame - 1, int(b.y)))
        x2 = max(0, min(w_frame - 1, int(b.x + b.w)))
        y2 = max(0, min(h_frame - 1, int(b.y + b.h)))
        if x2 <= x1 or y2 <= y1:
            continue
        colour = _GREEN_BGR if b.known else _AMBER_BGR

        cv2.rectangle(frame_bgr, (x1, y1), (x2, y2), colour, 2)

        # Label background (filled) + label text. Sized off the actual
        # text extent so a long name doesn't get clipped.
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 0.5
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(b.label, font, scale, thickness)
        pad_x, pad_y = 4, 3
        label_w = tw + pad_x * 2
        label_h = th + pad_y * 2 + baseline

        # Try to place the label above the box; if that goes off the
        # top edge, drop it inside the top-left corner instead.
        ly1 = y1 - label_h
        if ly1 < 0:
            ly1 = y1
        ly2 = ly1 + label_h
        lx1 = x1
        lx2 = min(w_frame - 1, x1 + label_w)

        cv2.rectangle(
            frame_bgr, (lx1, ly1), (lx2, ly2), colour, thickness=cv2.FILLED
        )
        # Text colour: black on green (good contrast); black on amber
        # too (the design's amber-on-black label is unreadable at this
        # scale).
        cv2.putText(
            frame_bgr,
            b.label,
            (lx1 + pad_x, ly1 + pad_y + th),
            font,
            scale,
            _BLACK_BGR,
            thickness,
            lineType=cv2.LINE_AA,
        )


def encode_jpeg(frame_bgr, quality: int = 70) -> Optional[bytes]:  # type: ignore[no-untyped-def]
    """JPEG-encode the (already-annotated) BGR frame.

    Quality 70 is the LAN sweet spot — sharp enough for face ID
    readability, ~80 KB for a 1280×720 frame. External exposure
    would warrant a lower number (or a switch to H.264 via WebRTC,
    out of scope for P28.5).
    """

    import cv2  # noqa: PLC0415

    ok, buf = cv2.imencode(
        ".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)]
    )
    if not ok:
        return None
    return bytes(buf.tobytes())
