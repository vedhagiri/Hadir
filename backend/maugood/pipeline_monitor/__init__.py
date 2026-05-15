"""Unified Pipeline Monitor — single endpoint aggregating every worker.

Read-only. The router walks each subsystem (capture_manager,
clip_pipeline, every scheduler instance), collects per-worker stats
in a uniform shape, and groups them so the frontend can render one
table with three category sections.

The fan-out logic lives in ``aggregator.py``; the FastAPI surface
lives in ``router.py``.
"""

from maugood.pipeline_monitor.router import router  # noqa: F401
