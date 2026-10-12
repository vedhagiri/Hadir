"""Insights — interactive attendance dashboards (Overall / Department / Person).

Read-only JSON views over the same data the Template 1 attendance PDF
renders. Every figure is produced by the PDF context builders in
``maugood.reporting.pdf`` (``_daily_context`` / ``_range_context`` /
``_employee_range_context`` + their row helpers) so the dashboard and
the PDF can never disagree. No new tables, no writes.

Public surface: ``router`` — mounted by ``maugood.main.create_app``.
"""

from maugood.insights.router import router

__all__ = ["router"]
