"""Pure classification of audit ``action`` codes for the Audit Log page.

The audit table stores dotted action codes (``auth.login.failure``,
``clip_cleanup.auto_deleted_after_processing`` …). The read-only Audit
Log surface groups them into a small set of **categories**, tags each
with a **severity**, and flags high-volume read/housekeeping actions as
**routine** so the UI can hide them by default.

No DB, no IO — the router resolves a tenant's distinct action list and
uses these helpers to turn category / kind filters into explicit
``action IN (...)`` lists. Unknown actions fall back to ``other`` /
``info`` / not-routine, so a new audit action never disappears from the
log just because nobody added it here.
"""

from __future__ import annotations

import re
from typing import Iterable, Literal

Category = Literal[
    "security",
    "people",
    "attendance",
    "devices",
    "storage",
    "reports",
    "settings",
    "other",
]
Severity = Literal["info", "warning", "high"]

CATEGORIES: tuple[str, ...] = (
    "security",
    "people",
    "attendance",
    "devices",
    "storage",
    "reports",
    "settings",
    "other",
)

KINDS: tuple[str, ...] = ("security", "failures", "changes", "system")

# Longest matching prefix wins, so specific codes (``auth.preferred_``)
# can override their family (``auth.``). Exact codes are prefixes too.
_PREFIX_CATEGORY: dict[str, str] = {
    # Security — sign-in, sessions, identity providers, operator access.
    "auth.": "security",
    "super_admin.": "security",
    "user.password_reset": "security",
    "entra.group_role": "security",
    "report.signed_url_downloaded": "security",
    # People.
    "employee.": "people",
    "user.": "people",
    "photo.": "people",
    "department.": "people",
    "division.": "people",
    "section.": "people",
    "manager_assignment.": "people",
    "unidentified_face.": "people",
    "delete_request.": "people",
    "custom_field.": "people",
    "entra.": "people",
    "pdpl": "people",
    # Attendance, policies, leave and requests.
    "attendance.": "attendance",
    "attendance_calendar.": "attendance",
    "shift_policy.": "attendance",
    "policy_assignment.": "attendance",
    "holiday.": "attendance",
    "leave_type.": "attendance",
    "approved_leave.": "attendance",
    "request.": "attendance",
    "request_reason_category.": "attendance",
    # Cameras, devices, capture pipeline.
    "camera.": "devices",
    "capture.": "devices",
    "live_capture.": "devices",
    "live_view.": "devices",
    "live_feed.": "devices",
    "device.": "devices",
    "detection_event.": "devices",
    "identification.": "devices",
    "worker_restart": "devices",
    "pipeline.": "devices",
    # Clips + storage housekeeping.
    "person_clip.": "storage",
    "clip_cleanup.": "storage",
    "clip_pipeline.": "storage",
    "uploaded_video.": "storage",
    "retention.": "storage",
    "queue.": "storage",
    # Reports + exports + email delivery.
    "report.": "reports",
    "report_schedule.": "reports",
    "attendance_calendar.exported": "reports",
    "attendance_email.": "reports",
    "pipeline_analytics.": "reports",
    "erp_export.": "reports",
    "employee.exported": "reports",
    "camera.exported": "reports",
    "audit_log.exported": "reports",
    # Workspace + system settings.
    "tenant_settings.": "settings",
    "tenant.": "settings",
    "system.": "settings",
    "branding.": "settings",
    "email_config.": "settings",
    "attendance_email.config": "settings",
    "erp_export.config": "settings",
    "auth.preferred_": "settings",
    "auth.oidc.config": "security",
    "auth.google.config": "security",
    "clip_cleanup.auto_delete_setting": "settings",
    "clip_cleanup.daily_setting": "settings",
    "clip_cleanup.retention_updated": "settings",
    "capture.worker.detection_config_updated": "devices",
}

# High-severity: destructive or privileged actions.
_HIGH_RE = re.compile(
    r"(hard_deleted|purged|bulk_deleted|pdpl|password_reset|access_as\.start|"
    r"rate_limited|queue\.cleared|config_deleted|request\.admin\.|"
    r"delete_request\.(approved|hr_self_approved)|employee\.soft_deleted|"
    r"(^|\.)deleted$|logo_deleted)"
)
# Warning: failures, rejections, security-config edits.
_WARNING_RE = re.compile(
    r"(failure|failed|fail$|rejected|expired|denied|"
    r"auth\.(oidc|google)\.config_updated|entra\.group_role|"
    r"auth\.role\.switched|super_admin\.access_as|user\.updated|"
    r"clip_cleanup\.executed|retry_failed|restart)"
)

# Sign-in failures (the security tile's sub-line + "failures" kind).
_FAILURE_RE = re.compile(
    r"^(auth\.(login|oidc\.login|google\.login)\.(failure|rate_limited)|"
    r"super_admin\.login\.failure)$"
)

# Routine = high-volume reads + boot housekeeping that floods the log.
_ROUTINE_RE = re.compile(
    r"(\.viewed$|_viewed$|\.streamed$|subscribed$|"
    r"^live_view\.(opened|closed)$|^live_feed\.stream\.(opened|closed)$|"
    r"^auth\.session\.refreshed$|^capture\.worker\.started_at_boot$|"
    r"recovered_at_boot$|^camera\.previewed$|"
    r"^request\.attachment\.downloaded$)"
)

# Data change = the trailing verb mutates something.
_CHANGE_RE = re.compile(
    r"(creat|updat|delet|purg|import|_set$|\.set$|assign|remov|mapped|"
    r"reorder|upload|approv|reject|cancel|submit|regenerat|rotat|"
    r"provision|swept|cleared|executed|auto_deleted|auto_deactivated|"
    r"synced|resynced|reembedded|rematched|override)"
)


def category_of(action: str) -> str:
    best = ""
    cat = "other"
    for prefix, c in _PREFIX_CATEGORY.items():
        if action.startswith(prefix) and len(prefix) > len(best):
            best = prefix
            cat = c
    return cat


def severity_of(action: str) -> str:
    if _HIGH_RE.search(action):
        return "high"
    if _WARNING_RE.search(action):
        return "warning"
    return "info"


def is_routine(action: str) -> bool:
    return bool(_ROUTINE_RE.search(action))


def is_failure(action: str) -> bool:
    return bool(_FAILURE_RE.match(action))


def is_change(action: str) -> bool:
    if is_routine(action) or category_of(action) == "security":
        return False
    verb = action.rsplit(".", 1)[-1]
    return bool(_CHANGE_RE.search(verb))


def actions_in_categories(actions: Iterable[str], cats: Iterable[str]) -> list[str]:
    wanted = set(cats)
    return [a for a in actions if category_of(a) in wanted]


def routine_actions(actions: Iterable[str]) -> list[str]:
    return [a for a in actions if is_routine(a)]


def humanize(action: str) -> str:
    """English fallback sentence for CSV export: ``clip_cleanup.executed``
    → ``Clip cleanup executed``."""

    words = action.replace(".", " ").replace("_", " ").split()
    if not words:
        return action
    text = " ".join(words)
    return text[0].upper() + text[1:]
