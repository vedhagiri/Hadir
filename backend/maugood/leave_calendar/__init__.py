"""Leaves + holidays + tenant settings (v1.0 P11).

Three CRUD surfaces plus the tenant-settings panel:

* ``/api/leave-types`` — Admin + HR. Seeded with Annual / Sick /
  Emergency / Unpaid; operators can add custom types.
* ``/api/holidays`` — Admin + HR. List + create + Excel import.
* ``/api/approved-leaves`` — Admin + HR. The ledger view today.
  P14/P15 add the submission + approval workflow that creates
  rows here automatically.
* ``/api/tenant-settings`` — Admin + HR. Holds ``weekend_days``
  + ``timezone``. Per the P11 red line, **timezone is
  tenant-scoped, not server-scoped** — every attendance
  comparison runs through the value here.

Audit hooks on every mutation
(``leave_type.{created,updated,deactivated}``,
``holiday.{created,deleted}``,
``approved_leave.{created,deleted}``,
``tenant_settings.updated``).
"""

from maugood.leave_calendar.router import router

__all__ = ["router"]
