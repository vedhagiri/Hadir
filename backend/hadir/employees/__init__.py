"""Employees feature package (P5).

This layer owns the ``employees`` and ``employee_photos`` tables. Photos
are schema-only in P5 — ingestion, encryption, and the admin approval UX
land in P6.

Public surface kept narrow: the FastAPI router. Repository, schemas, and
Excel helpers are imported by the router directly.
"""

from hadir.employees.router import router

__all__ = ["router"]
