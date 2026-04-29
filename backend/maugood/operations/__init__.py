"""Tenant operations endpoints (P28.8).

Worker monitoring + per-camera restart for tenant Admin. The four
endpoints under ``/api/operations/*`` plus the camera-metadata PATCH
hook that lives here so the worker module owns its own write surface.
"""

from maugood.operations.router import router

__all__ = ["router"]
