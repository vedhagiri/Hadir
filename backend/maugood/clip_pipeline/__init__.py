"""Queue-based clip-processing pipeline.

Two always-on stages — Cropping and Matching — share one in-memory
producer/consumer pipeline. The operator submits a batch of
``(clip_id, use_case)`` jobs via the router; each job flows:

    submit  →  CroppingQueue  →  Cropping worker  →  MatchingQueue
                                                          ↓
                                                  Matching worker
                                                          ↓
                                              clip_processing_results
                                              + batch tracker update

The two workers are intentionally separate threads with their own
queues so the InsightFace detector lock (CPU-bound, process-wide)
doesn't pin the matcher thread, which is read-only against the
in-memory matcher_cache and can keep crunching while detection is
busy on the next clip.

Public singleton: ``clip_pipeline``. Lifespan calls ``.start()`` /
``.stop()``.
"""

from maugood.clip_pipeline.pipeline import clip_pipeline  # noqa: F401
