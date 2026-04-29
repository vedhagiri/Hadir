"""Super-Admin role + console (v1.0 P3).

MTS staff log in here, see every tenant, and "Access as" any tenant
for support. Authentication is independent of per-tenant ``users`` —
operators live in ``public.mts_staff``, sessions in
``public.super_admin_sessions``, and every cross-tenant touch is
audit-logged in both ``public.super_admin_audit`` and the target
tenant's ``audit_log``.

Module map:

* ``sessions`` — opaque token sessions in ``public.super_admin_sessions``.
* ``audit`` — append-only writer for ``public.super_admin_audit``,
  plus the dual-write helper that fires from per-tenant audit calls.
* ``dependencies`` — ``current_super_admin`` FastAPI dep + the
  cookie name + the synthetic-user shim.
* ``repository`` — read helpers (tenants list with stats, recent
  audit events, etc.) used by the console router.
* ``router`` — ``/api/super-admin/*`` endpoints.
"""

from maugood.super_admin.router import router

__all__ = ["router"]
