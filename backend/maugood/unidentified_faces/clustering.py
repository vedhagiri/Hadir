"""Greedy cosine-similarity clustering for unidentified face embeddings.

Algorithm
---------
For each event (processed oldest-first so earlier sightings anchor
the centroid):

1. Decrypt + L2-normalise the Fernet-encrypted float32 embedding.
2. Compare with every existing cluster centroid via dot product
   (equivalent to cosine similarity on unit vectors).
3. If the best similarity exceeds ``threshold``, add the event to that
   cluster and update its centroid (running normalised mean).
4. Otherwise, open a new singleton cluster.

Time: O(n × C) where C is the number of clusters found — fast in
practice because face-space clusters are small relative to n.

No new DB tables. Clusters are ephemeral per request.

Performance guardrail
---------------------
``MAX_EVENTS_PER_RUN`` caps the number of embeddings loaded and
decrypted in a single call so the endpoint stays under ~3 s on large
datasets. The caller slices to the most-recent events before handing
them to this module.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from maugood.identification.embeddings import decrypt_embedding

logger = logging.getLogger(__name__)

# Cosine similarity threshold: two crops are "same person" when their
# normalised dot product exceeds this value. Set to match the
# identification match threshold so unknown-person grouping uses the
# same standard as the identification pipeline. Operators can raise it
# via the threshold slider to get tighter, higher-confidence clusters.
DEFAULT_CLUSTER_THRESHOLD = 0.65

# Hard cap on events processed in one run. At ~2.7 KB/event (Fernet
# overhead on 2 KB plaintext) 5,000 events stay under ~10 s on slow
# hardware. Raised from 1,500 so the gallery shows the full recent
# history rather than silently dropping older events.
MAX_EVENTS_PER_RUN = 5_000


@dataclass
class RawEvent:
    id: int
    embedding_enc: bytes
    face_crop_path: Optional[str]
    captured_at: datetime
    camera_id: int
    camera_name: str
    bbox: Optional[dict] = None  # {"x", "y", "w", "h"} from detection_events.bbox


# Per-event metadata derived from bbox geometry. Cheap, no decode required.
# Operators filter inside an opened cluster by these chips.

# Pixel-area bands for the quality heuristic. The detector typically lands
# adult-face bboxes at:
#   - 60×60 (≈3600 px²) when far from camera → "low" — too small for confident match
#   - 120×120 (≈14_400 px²) at typical office distance → "medium"
#   - 200×200 (≈40_000 px²) at a door reader → "high"
_QUALITY_HIGH_PX2 = 22500   # ≈150×150
_QUALITY_MED_PX2 = 8100     # ≈90×90

# Aspect-ratio cut for the pose heuristic. A near-frontal face bbox is
# roughly square (0.7–1.0). A profile / 3/4-turn face is narrower because
# the detector clips the visible cheek. Outside both bands → "partial"
# (atypical aspect — often a clipped or occluded face).
_POSE_FRONT_MIN_AR = 0.65
_POSE_FRONT_MAX_AR = 1.10
_POSE_SIDE_MIN_AR = 0.40


def _quality_from_bbox(bbox: Optional[dict]) -> str:
    if not bbox:
        return "unknown"
    try:
        w = float(bbox.get("w", 0))
        h = float(bbox.get("h", 0))
    except (TypeError, ValueError):
        return "unknown"
    area = max(0.0, w) * max(0.0, h)
    if area >= _QUALITY_HIGH_PX2:
        return "high"
    if area >= _QUALITY_MED_PX2:
        return "medium"
    return "low"


def _face_type_from_bbox(bbox: Optional[dict]) -> str:
    if not bbox:
        return "unknown"
    try:
        w = float(bbox.get("w", 0))
        h = float(bbox.get("h", 0))
    except (TypeError, ValueError):
        return "unknown"
    if w <= 0 or h <= 0:
        return "unknown"
    aspect = w / h
    if _POSE_FRONT_MIN_AR <= aspect <= _POSE_FRONT_MAX_AR:
        return "front"
    if _POSE_SIDE_MIN_AR <= aspect < _POSE_FRONT_MIN_AR:
        return "side"
    return "partial"


@dataclass
class FaceCluster:
    cluster_id: str           # "c{representative_event_id}"
    representative_event_id: int
    event_ids: list[int]
    crop_event_ids: list[int] # subset with face_crop_path set
    count: int
    first_seen: datetime
    last_seen: datetime
    camera_ids: list[int]
    camera_names: list[str]
    # Intra-cluster similarity stats (useful for quality reporting)
    avg_similarity: float = 0.0
    # Per-event metadata, parallel to ``event_ids`` (same length, same order).
    # Filled by ``cluster_events``. Frontend uses these to drive in-cluster
    # filter chips (similarity / quality / pose) without a second round-trip.
    event_similarities: list[float] = field(default_factory=list)
    event_qualities: list[str] = field(default_factory=list)
    event_face_types: list[str] = field(default_factory=list)


def cluster_events(
    raw_events: list[RawEvent],
    threshold: float = DEFAULT_CLUSTER_THRESHOLD,
) -> list[FaceCluster]:
    """Return clusters sorted descending by count.

    Events without a usable embedding (null, decrypt error, wrong
    shape) are silently skipped — they can't participate in cosine
    similarity clustering.
    """
    if not raw_events:
        return []

    # Enforce hard cap — take the *most recent* events first so the
    # clustering reflects current patterns rather than old stale data.
    if len(raw_events) > MAX_EVENTS_PER_RUN:
        logger.warning(
            "unidentified_faces: capping at %d events (got %d)",
            MAX_EVENTS_PER_RUN,
            len(raw_events),
        )
        raw_events = raw_events[:MAX_EVENTS_PER_RUN]

    # Decrypt and normalise — collect only events that succeed.
    vectors: list[np.ndarray] = []
    valid: list[RawEvent] = []
    for ev in raw_events:
        try:
            vec = decrypt_embedding(ev.embedding_enc).astype(np.float32)
            norm = float(np.linalg.norm(vec))
            if norm < 1e-9:
                continue
            vectors.append(vec / norm)
            valid.append(ev)
        except Exception as exc:  # noqa: BLE001
            logger.debug("embedding decrypt error for event %d: %s", ev.id, exc)
            continue

    if not valid:
        return []

    emb_dim = vectors[0].shape[0]
    # Pre-allocate centroid matrix — worst case every event is a unique
    # person (all singletons). Using a fixed-size array + an integer
    # index avoids O(n²) copies from repeated np.vstack / np.append.
    # ``centroids_arr[:n_clusters] @ vec`` is a single BLAS gemv call
    # instead of a Python loop, giving a 4-10× speed-up on typical
    # cluster counts.
    centroids_arr = np.empty((len(vectors), emb_dim), dtype=np.float32)
    n_clusters = 0
    buckets: list[list[int]] = []        # indices into `valid`
    intra_sims: list[list[float]] = []   # per-cluster similarity log

    for i, vec in enumerate(vectors):
        if n_clusters > 0:
            # Vectorized batch similarity — one BLAS gemv instead of a
            # Python loop over centroids.
            sims = centroids_arr[:n_clusters] @ vec  # shape (n_clusters,)
            best_ci = int(np.argmax(sims))
            best_sim = float(sims[best_ci])
        else:
            best_ci = -1
            best_sim = threshold - 1e-9

        if n_clusters > 0 and best_sim > threshold:
            buckets[best_ci].append(i)
            intra_sims[best_ci].append(best_sim)
            # Update centroid as normalised running mean.
            n = len(buckets[best_ci])
            c = centroids_arr[best_ci] * (n - 1) + vec
            c_norm = float(np.linalg.norm(c))
            centroids_arr[best_ci] = c / c_norm if c_norm > 1e-9 else c
        else:
            centroids_arr[n_clusters] = vec
            n_clusters += 1
            buckets.append([i])
            intra_sims.append([1.0])

    # Recompute per-event similarities against the FINAL cluster centroid.
    # The values stored in ``intra_sims`` during the greedy pass are noisy
    # (running-centroid drift) and the seed event always carries a 1.0
    # placeholder which makes in-cluster filtering misleading. The second
    # pass is cheap — one BLAS dot product per event — and gives operators
    # a meaningful spread to filter against (e.g. "show events ≥ 80% match
    # to the cluster prototype").
    final_intra_sims: list[list[float]] = []
    for ci in range(n_clusters):
        final_centroid = centroids_arr[ci]
        bucket_sims: list[float] = []
        for vec_idx in buckets[ci]:
            sim = float(vectors[vec_idx] @ final_centroid)
            # Numerical noise can drift over 1.0; clamp to keep the API tidy.
            bucket_sims.append(min(1.0, max(0.0, sim)))
        final_intra_sims.append(bucket_sims)

    # Build output — largest clusters first.
    result: list[FaceCluster] = []
    for bucket, sims in sorted(
        zip(buckets, final_intra_sims), key=lambda x: len(x[0]), reverse=True
    ):
        evs = [valid[i] for i in bucket]
        times = sorted(ev.captured_at for ev in evs)
        cam_seen: dict[int, str] = {}
        for ev in evs:
            cam_seen[ev.camera_id] = ev.camera_name

        crop_ids = [ev.id for ev in evs if ev.face_crop_path]
        # Pick the representative: prefer a crop event; use first otherwise.
        rep_id = crop_ids[0] if crop_ids else evs[0].id
        avg_sim = float(np.mean(sims)) if sims else 1.0

        # Per-event arrays parallel to event_ids — sims are now real
        # similarities to the final centroid, not running-pass placeholders.
        event_ids = [ev.id for ev in evs]
        event_similarities = [float(s) for s in sims]
        event_qualities = [_quality_from_bbox(ev.bbox) for ev in evs]
        event_face_types = [_face_type_from_bbox(ev.bbox) for ev in evs]

        result.append(
            FaceCluster(
                cluster_id=f"c{rep_id}",
                representative_event_id=rep_id,
                event_ids=event_ids,
                crop_event_ids=crop_ids,
                count=len(evs),
                first_seen=times[0],
                last_seen=times[-1],
                camera_ids=list(cam_seen.keys()),
                camera_names=list(cam_seen.values()),
                avg_similarity=avg_sim,
                event_similarities=event_similarities,
                event_qualities=event_qualities,
                event_face_types=event_face_types,
            )
        )

    return result
