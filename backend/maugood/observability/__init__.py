"""P29 — operator resource-monitoring telemetry.

Three Admin-only, tenant-scoped endpoints surface live operator
metrics for the Pipeline Monitor "Resources" tab:

* ``GET /api/operations/resources/host``    — System overview
* ``GET /api/operations/resources/cameras`` — Per-camera resource share
* ``GET /api/operations/resources/stages``  — Pipeline stage breakdown

None of the endpoints emit ``audit_log`` rows — they're polled every
~5 s by the Resources tab and polling-audit would balloon the table.
Audit emission stays on the state-changing buttons next door
(restart-all etc.) per the existing P28.8 pattern.

Host CPU / memory / disk / network are host-wide regardless of which
tenant Admin requests them — the host is shared. The detector lock
and matcher cache are also process-global; their stage rows in
``/resources/stages`` carry the ``shared_backend_process`` label so
the UI can be explicit about that.

Per-camera socket-counter network bytes are sampled by a background
tick that shells out to ``ss -tnpi`` and parses ``bytes_received``
per established TCP connection bound to a camera's RTSP host:port.
If ``ss`` is missing or the parse fails the field degrades to
``None`` and the UI hides the value — never raises.
"""

from maugood.observability.router import router

__all__ = ["router"]
