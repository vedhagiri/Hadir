"""Manager assignments (v1.0 P8).

Per-tenant many-to-many between Manager users and employees, with
exactly-one ``is_primary`` per employee enforced by the partial
unique index from migration 0012. This package exposes:

* ``router`` — Admin-only ``/api/manager-assignments`` endpoints.
* ``repository`` — DB helpers, including the
  ``get_manager_visible_employee_ids`` scope helper that the
  attendance router unions with department membership when
  resolving Manager visibility.

Red lines:

* The primary-manager rule lives in the database (partial unique
  index). Application code can clear+set in one transaction, but a
  buggy direct INSERT that tries to create two primaries is
  rejected by Postgres regardless.
* Every assignment change is audit-logged
  (``manager_assignment.{created,deleted,primary_set}``).
"""

from hadir.manager_assignments.router import router

__all__ = ["router"]
