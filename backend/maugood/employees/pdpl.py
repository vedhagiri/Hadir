"""PDPL / GDPR delete-on-request flow (v1.0 P25).

BRD references:

* **NFR-COMP-003** — operator-driven right-to-erasure.
* **FR-EMP-009** — Admin-only endpoint with confirmation token.
* **NFR-RET-004** — attendance + audit records retain even
  when the underlying employee is redacted.

Behaviour:

* Drops every ``employee_photos`` row + Fernet file on disk.
* Drops every ``custom_field_values`` row.
* Sets ``employees.status = 'deleted'``, redacts ``full_name``
  to ``[deleted]``, ``email`` to ``deleted-{id}@maugood.local``,
  and clears ``employee_photos`` from the matcher cache.
* Keeps ``attendance_records``, ``detection_events``,
  ``requests``, ``approved_leaves``, ``audit_log`` — these are
  retained per BRD as verifiable history. The redacted name
  on the employee row means the audit trail still references
  ``[deleted]`` rather than the original PII.
* Writes a special audit row ``pdpl_delete`` with the
  before-state PII embedded so an operator running an audit
  later can verify the request was honoured. The audit row
  itself is append-only at the DB grant level (P2) so it
  cannot be expunged later.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.engine import Connection

from maugood.auth.audit import write_audit
from maugood.db import (
    custom_field_values,
    employee_photos,
    employees,
)
from maugood.identification.matcher import matcher_cache
from maugood.logging_config import audit_logger
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


REDACTED_NAME = "[deleted]"


def _redacted_email(employee_id: int) -> str:
    """Per-employee placeholder so the unique constraint
    ``(tenant_id, email)`` is satisfied without leaking the
    original address."""

    return f"deleted-{employee_id}@maugood.local"


@dataclass
class PdplDeleteResult:
    employee_id: int
    photo_rows_deleted: int
    photo_files_deleted: int
    custom_field_values_deleted: int
    redacted_name: str
    redacted_email: str
    previous_full_name: str
    previous_email: str | None


def _drop_photo_file(file_path_str: str) -> bool:
    """Best-effort delete of a photo's encrypted file.

    Returns True when a real file was removed. The DB row is
    deleted regardless — leaving a dangling row would defeat
    the right-to-erasure intent.
    """

    try:
        p = Path(file_path_str)
    except (TypeError, ValueError):
        return False
    if not p.exists():
        return False
    try:
        p.unlink()
        return True
    except OSError as exc:
        logger.warning(
            "pdpl: failed to delete photo file %s: %s", p, exc
        )
        return False


def pdpl_delete_employee(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    actor_user_id: int,
    confirmation_phrase: str,
) -> PdplDeleteResult:
    """Apply the PDPL delete to a single employee.

    The caller MUST validate the confirmation_phrase before
    calling — this function trusts that the operator has
    already typed the magic phrase. The router is the gate.
    """

    employee = conn.execute(
        select(
            employees.c.id,
            employees.c.full_name,
            employees.c.email,
            employees.c.status,
        ).where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
    ).first()
    if employee is None:
        raise ValueError("employee not found")
    if employee.status == "deleted":
        raise ValueError("employee already pdpl-deleted")

    previous_full_name = str(employee.full_name)
    previous_email = (
        str(employee.email) if employee.email is not None else None
    )

    # 1. Photos: collect file paths then drop rows + files.
    photo_rows = conn.execute(
        select(employee_photos.c.id, employee_photos.c.file_path).where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.employee_id == employee_id,
        )
    ).all()
    photo_files_deleted = 0
    for row in photo_rows:
        if _drop_photo_file(str(row.file_path)):
            photo_files_deleted += 1
    photo_rows_deleted = 0
    if photo_rows:
        result = conn.execute(
            delete(employee_photos).where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.employee_id == employee_id,
            )
        )
        photo_rows_deleted = int(result.rowcount or 0)

    # 2. Custom field values — every per-employee row across
    # every defined field. The field definitions themselves
    # stay (they're tenant-wide).
    cfv_result = conn.execute(
        delete(custom_field_values).where(
            custom_field_values.c.tenant_id == scope.tenant_id,
            custom_field_values.c.employee_id == employee_id,
        )
    )
    custom_field_values_deleted = int(cfv_result.rowcount or 0)

    # 3. Redact PII on the employee row + flip status.
    new_email = _redacted_email(employee_id)
    conn.execute(
        update(employees)
        .where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
        .values(
            full_name=REDACTED_NAME,
            email=new_email,
            status="deleted",
        )
    )

    # 4. Invalidate the in-memory matcher cache so a captured
    # face never re-matches against this employee post-delete.
    try:
        matcher_cache.invalidate_employee(scope.tenant_id, employee_id)
    except Exception:  # noqa: BLE001
        # The matcher is lazily-loaded — invalidating an
        # employee that wasn't cached is a no-op. Failures
        # here are non-fatal (the cache is rebuilt on demand).
        logger.debug(
            "pdpl: matcher_cache.invalidate_employee no-op",
            exc_info=True,
        )

    # 5. Audit row — captures the before-state so an auditor
    # running ``SELECT * FROM audit_log WHERE action='pdpl_delete'``
    # can see what was redacted, when, and by whom.
    audit_payload: dict[str, Any] = {
        "previous_full_name": previous_full_name,
        "previous_email": previous_email,
        "photo_rows_deleted": photo_rows_deleted,
        "photo_files_deleted": photo_files_deleted,
        "custom_field_values_deleted": custom_field_values_deleted,
        "confirmation_phrase": confirmation_phrase,
    }
    write_audit(
        conn,
        tenant_id=scope.tenant_id,
        actor_user_id=actor_user_id,
        action="pdpl_delete",
        entity_type="employee",
        entity_id=str(employee_id),
        before={"status": str(employee.status), "full_name": previous_full_name},
        after={"status": "deleted", "full_name": REDACTED_NAME},
    )
    # P25: also surface the breadcrumb to the audit *log file*
    # so an operator without DB access can see the event in
    # ``backend/logs/audit.log``. The file copy is intentionally
    # lighter than the DB row — no PII echo.
    audit_logger().info(
        "pdpl_delete tenant=%s employee_id=%s actor_user_id=%s "
        "photos=%d files=%d custom_field_values=%d",
        scope.tenant_id,
        employee_id,
        actor_user_id,
        photo_rows_deleted,
        photo_files_deleted,
        custom_field_values_deleted,
    )

    return PdplDeleteResult(
        employee_id=employee_id,
        photo_rows_deleted=photo_rows_deleted,
        photo_files_deleted=photo_files_deleted,
        custom_field_values_deleted=custom_field_values_deleted,
        redacted_name=REDACTED_NAME,
        redacted_email=new_email,
        previous_full_name=previous_full_name,
        previous_email=previous_email,
    )


# ---- exposed constants -------------------------------------------------
#
# The router checks this phrase against the request body. We
# require an exact match (case + whitespace sensitive) so a
# sloppy curl with a typo can't accidentally invoke a delete.
PDPL_CONFIRMATION_PHRASE = "I CONFIRM PDPL DELETION"


# ---- purge (operator-driven full delete) ------------------------------
#
# Distinct from ``pdpl_delete_employee`` (which preserves attendance
# + audit history per BRD NFR-RET-004). ``purge_employee`` is wired
# from the bulk-delete UI's "hard" mode so an operator can wipe a
# tenant's roster cleanly during setup / pilot rotation. Every
# referencing row is removed:
#
#   * employee_photos          — cascade
#   * custom_field_values      — cascade
#   * attendance_records       — cascade
#   * approved_leaves          — cascade
#   * requests                 — cascade
#   * manager_assignments      — cascade
#   * delete_requests          — cascade
#   * detection_events.employee_id            → SET NULL (history kept)
#   * detection_events.former_match_employee_id → SET NULL (history kept)
#
# detection_events rows survive with their face crops still on disk
# but no employee linkage — the operator can age them out via the
# capture-events retention sweep separately. Audit log row stays
# (append-only at the DB grant level).


@dataclass
class PurgeEmployeeResult:
    employee_id: int
    photo_files_deleted: int
    full_name: str


def purge_employee(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    actor_user_id: int,
) -> PurgeEmployeeResult:
    """Drop an employee row and every referencing row.

    Photos on disk are removed best-effort first (so the on-disk
    state matches the DB state after commit). The DB DELETE cascades
    via the FK constraints declared in ``maugood/db.py``.
    """

    employee = conn.execute(
        select(employees.c.id, employees.c.full_name).where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
    ).first()
    if employee is None:
        raise ValueError("employee not found")

    full_name = str(employee.full_name)

    photo_paths = [
        str(r.file_path)
        for r in conn.execute(
            select(employee_photos.c.file_path).where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.employee_id == employee_id,
            )
        ).all()
    ]
    photo_files_deleted = 0
    for path in photo_paths:
        if _drop_photo_file(path):
            photo_files_deleted += 1

    # Delete the employee row — every referencing CASCADE FK clears
    # the dependent rows in one transaction. detection_events FKs
    # are SET NULL so capture history survives anonymously.
    conn.execute(
        delete(employees).where(
            employees.c.tenant_id == scope.tenant_id,
            employees.c.id == employee_id,
        )
    )

    try:
        matcher_cache.invalidate_employee(scope.tenant_id, employee_id)
    except Exception:  # noqa: BLE001
        logger.debug(
            "purge: matcher_cache.invalidate_employee no-op", exc_info=True
        )

    write_audit(
        conn,
        tenant_id=scope.tenant_id,
        actor_user_id=actor_user_id,
        action="employee.purged",
        entity_type="employee",
        entity_id=str(employee_id),
        before={"full_name": full_name},
        after={"photo_files_deleted": photo_files_deleted},
    )
    audit_logger().info(
        "employee.purged tenant=%s employee_id=%s actor_user_id=%s "
        "photo_files=%d",
        scope.tenant_id,
        employee_id,
        actor_user_id,
        photo_files_deleted,
    )

    return PurgeEmployeeResult(
        employee_id=employee_id,
        photo_files_deleted=photo_files_deleted,
        full_name=full_name,
    )
