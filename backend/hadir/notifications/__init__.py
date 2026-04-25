"""Notifications subsystem (v1.0 P20)."""

from hadir.notifications.categories import (
    ALL_CATEGORIES,
    CATEGORY_LABELS,
    Category,
)
from hadir.notifications.producer import (
    notify_admin_override,
    notify_approval_assigned,
    notify_approval_decided,
    notify_camera_unreachable,
    notify_overtime_flagged,
    notify_report_ready,
    notify_user,
)
from hadir.notifications.repository import (
    NotificationRow,
    PreferenceRow,
    list_for_user,
    mark_all_read,
    mark_read,
    resolve_preference,
    set_preference,
    unread_count_for_user,
)
from hadir.notifications.router import router
from hadir.notifications.worker import notification_worker

__all__ = [
    "ALL_CATEGORIES",
    "CATEGORY_LABELS",
    "Category",
    "NotificationRow",
    "PreferenceRow",
    "list_for_user",
    "mark_all_read",
    "mark_read",
    "notification_worker",
    "notify_admin_override",
    "notify_approval_assigned",
    "notify_approval_decided",
    "notify_camera_unreachable",
    "notify_overtime_flagged",
    "notify_report_ready",
    "notify_user",
    "resolve_preference",
    "router",
    "set_preference",
]
