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

# Cosine similarity threshold: two crops are "same person" when
# their normalised dot product exceeds this value. Higher than the
# identification match threshold (0.45) because we want tight,
# high-confidence clusters, not loose "possibly same" groups.
DEFAULT_CLUSTER_THRESHOLD = 0.60

# Hard cap on events processed in one run. At ~2.7 KB/event
# (Fernet overhead on 2 KB plaintext) this keeps the decrypt
# wall-clock under ~3 s even on slow hardware.
MAX_EVENTS_PER_RUN = 1_500


@dataclass
class RawEvent:
    id: int
    embedding_enc: bytes
    face_crop_path: Optional[str]
    captured_at: datetime
    camera_id: int
    camera_name: str


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

    # Greedy clustering — O(n × C).
    centroids: list[np.ndarray] = []
    buckets: list[list[int]] = []        # indices into `valid`
    intra_sims: list[list[float]] = []   # per-cluster similarity log

    for i, vec in enumerate(vectors):
        best_ci = -1
        best_sim = threshold - 1e-9  # must strictly exceed threshold

        for ci, centroid in enumerate(centroids):
            sim = float(np.dot(vec, centroid))
            if sim > best_sim:
                best_sim = sim
                best_ci = ci

        if best_ci >= 0:
            buckets[best_ci].append(i)
            intra_sims[best_ci].append(best_sim)
            # Update centroid as normalised running mean.
            n = len(buckets[best_ci])
            c = centroids[best_ci] * (n - 1) + vec
            c_norm = float(np.linalg.norm(c))
            centroids[best_ci] = c / c_norm if c_norm > 1e-9 else c
        else:
            centroids.append(vec.copy())
            buckets.append([i])
            intra_sims.append([1.0])

    # Build output — largest clusters first.
    result: list[FaceCluster] = []
    for bucket, sims in sorted(
        zip(buckets, intra_sims), key=lambda x: len(x[0]), reverse=True
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

        result.append(
            FaceCluster(
                cluster_id=f"c{rep_id}",
                representative_event_id=rep_id,
                event_ids=[ev.id for ev in evs],
                crop_event_ids=crop_ids,
                count=len(evs),
                first_seen=times[0],
                last_seen=times[-1],
                camera_ids=list(cam_seen.keys()),
                camera_names=list(cam_seen.values()),
                avg_similarity=avg_sim,
            )
        )

    return result
