"""Attendance calendar (P28.6).

Read-only aggregations over the existing ``attendance_records`` rows
the engine produces (P10). No new tables — aggregations are computed
on read; query latency at 100 employees × 30 days is well under
100 ms on the dev DB.

Public surface: ``router`` — mounted by ``hadir.main.create_app``.
"""

from hadir.attendance_calendar.router import router

__all__ = ["router"]
