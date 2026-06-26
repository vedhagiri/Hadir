"""Pipeline Analytics — per-clip processing performance metrics.

Read-only surface over the perf columns on ``clip_processing_results``
(migration 0086) joined with ``person_clips`` + ``cameras``. Powers the
Pipeline Analytics tab: UC1-vs-UC2 stage-time comparison, a per-clip
metrics table, and a CSV export — so bottleneck analysis happens in-app
instead of via external shell scripts.
"""

from maugood.pipeline_analytics.router import router  # noqa: F401
