"""Per-tenant employee directory cache for live-capture labels (P28.5).

The capture worker draws a label like ``"Fatima Al-Kindi · 97%"`` on
every box. Resolving the name from ``employees`` on every frame would
add a DB round-trip at 4 fps × N detections — wasteful when employee
names change roughly never. This cache loads once per tenant and
serves ``employee_id → (name, code)`` lookups in O(1).

Stale-name acceptance: if an Admin renames an employee, the live
viewer keeps showing the old name until the backend restarts. That's
fine for live-camera labels; the canonical name is on the
``detection_events`` row that the WebSocket stream below the video
also surfaces, and that pulls fresh data per frame.

Tenant scoping: keyed by ``tenant_id``. The matcher already loads
embeddings per tenant; this cache piggy-backs on the same lifecycle
so the load cost is amortised.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from sqlalchemy import select

from maugood.db import employees, get_engine, tenant_context
from maugood.tenants.scope import TenantScope


logger = logging.getLogger(__name__)


class EmployeeDirectory:
    """Thread-safe ``employee_id → (full_name, employee_code)`` cache."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._per_tenant: dict[int, dict[int, tuple[str, str]]] = {}

    def label_for(
        self, scope: TenantScope, employee_id: int
    ) -> Optional[tuple[str, str]]:
        """Return ``(full_name, employee_code)`` or ``None`` if unknown."""

        entries = self._ensure_loaded(scope)
        return entries.get(employee_id)

    def invalidate(self, tenant_id: int) -> None:
        with self._lock:
            self._per_tenant.pop(tenant_id, None)

    def _ensure_loaded(self, scope: TenantScope) -> dict[int, tuple[str, str]]:
        with self._lock:
            entries = self._per_tenant.get(scope.tenant_id)
            if entries is not None:
                return entries

        # Load outside the lock — DB round-trip can be slow on cold
        # boot and we don't want to serialise other tenants' loads.
        entries = self._full_load(scope)
        with self._lock:
            self._per_tenant[scope.tenant_id] = entries
        logger.info(
            "employee directory loaded: tenant_id=%s employees=%d",
            scope.tenant_id,
            len(entries),
        )
        return entries

    def _full_load(self, scope: TenantScope) -> dict[int, tuple[str, str]]:
        engine = get_engine()
        with tenant_context(scope.tenant_schema):
            with engine.begin() as conn:
                rows = conn.execute(
                    select(
                        employees.c.id,
                        employees.c.full_name,
                        employees.c.employee_code,
                    ).where(employees.c.tenant_id == scope.tenant_id)
                ).all()
        return {
            int(r.id): (str(r.full_name), str(r.employee_code))
            for r in rows
        }


employee_directory = EmployeeDirectory()
