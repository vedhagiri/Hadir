"""On-demand attendance reports (P13).

Pilot scope: synchronous Excel generation via openpyxl write-only mode,
streamed back to the caller. No scheduled delivery, no PDF, no email —
all deferred per PROJECT_CONTEXT §8.
"""

from maugood.reporting.router import router

__all__ = ["router"]
