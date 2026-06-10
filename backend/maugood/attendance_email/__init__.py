"""Attendance status emails (Present / Late / Absent) to employees.

Three pieces:

* ``repository`` — the ``attendance_email_log`` queue/log table CRUD +
  the ``tenant_settings.attendance_email_config`` toggle bag.
* ``producer`` — enqueue hooks: first-check-in detection on the
  attendance recompute path (present/late) and the yesterday-absent
  sweep (absent).
* ``worker`` — drain step invoked by the notification email worker's
  30-second tick; renders the branded template and dispatches via the
  tenant's Settings → Email provider with 3-attempt retry.

Recipients are **employees** (``employees.email``), not users — an
employee receives these whether or not they hold a login. Tenant-wide
toggles in Settings → Notifications govern the three categories; the
master switch is the Settings → Email ``enabled`` flag (both re-checked
at delivery time, so a flip takes effect within one tick).
"""

from maugood.attendance_email.router import router  # noqa: F401
