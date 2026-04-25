"""Attendance engine + scheduler (P10).

Pilot scope is deliberately small: one Fixed policy per tenant, no
leaves / holidays module, no historical recompute. The ``compute``
function in ``engine.py`` is kept pure — no DB, no network — so v1.0
can layer Flex/Ramadan/Custom handling on top without touching the
execution path.
"""

from hadir.attendance.scheduler import attendance_scheduler

__all__ = ["attendance_scheduler"]
