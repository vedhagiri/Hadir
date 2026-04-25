"""Notification categories — pure data, no DB / HTTP."""

from __future__ import annotations

from typing import Literal


Category = Literal[
    "approval_assigned",
    "approval_decided",
    "overtime_flagged",
    "camera_unreachable",
    "report_ready",
    "admin_override",
]


ALL_CATEGORIES: tuple[Category, ...] = (
    "approval_assigned",
    "approval_decided",
    "overtime_flagged",
    "camera_unreachable",
    "report_ready",
    "admin_override",
)


# Human labels for the prefs page + email subjects.
CATEGORY_LABELS: dict[str, str] = {
    "approval_assigned": "Approval assigned to me",
    "approval_decided": "My request decided",
    "overtime_flagged": "Overtime flagged",
    "camera_unreachable": "Camera unreachable",
    "report_ready": "Report ready",
    "admin_override": "Admin override",
}
