"""FastAPI router for ``/api/employees/*``.

Every CRUD operation writes an audit row via the append-only ``write_audit``
helper; the import path also writes a summary row with the import counts.

P28.7 opens read + write access to the **HR** role alongside **Admin**:

* List / get / export / create / patch — Admin or HR.
* Photo upload + delete — Admin or HR.
* Hard-delete (PDPL right-to-erasure) — still Admin-only.
* Lifecycle delete-request endpoints — see ``delete_requests.py`` for
  per-route role rules (Admin or HR submits; HR decides; Admin overrides).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from io import BytesIO
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, require_any_role, require_role
from hadir.custom_fields import repository as cf_repo
from hadir.db import get_engine
from hadir.employees import excel as excel_io
from hadir.employees import pdpl as pdpl_module
from hadir.employees import photos as photos_io
from hadir.employees import repository as repo
from hadir.identification import enrollment as id_enrollment
from hadir.identification.matcher import matcher_cache
from hadir.employees.schemas import (
    EmployeeCreateIn,
    EmployeeListOut,
    EmployeeOut,
    EmployeePatchIn,
    ImportError as ImportErrorSchema,
    ImportResult,
    ImportWarning as ImportWarningSchema,
    PhotoIngestAccepted,
    PhotoIngestRejected,
    PhotoIngestResult,
    PhotoListOut,
    PhotoOut,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/employees", tags=["employees"])

# P28.7: most endpoints now accept Admin OR HR. PDPL hard-delete is
# still Admin-only — see the comment on that handler.
ADMIN = Depends(require_role("Admin"))
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


def _row_to_out(row: repo.EmployeeRow) -> EmployeeOut:
    return EmployeeOut(
        id=row.id,
        employee_code=row.employee_code,
        full_name=row.full_name,
        email=row.email,
        department={
            "id": row.department_id,
            "code": row.department_code,
            "name": row.department_name,
        },
        status=row.status,  # type: ignore[arg-type]  -- DB CHECK limits to active|inactive|deleted (P25)
        photo_count=row.photo_count,
        created_at=row.created_at,
        designation=row.designation,
        phone=row.phone,
        reports_to_user_id=row.reports_to_user_id,
        reports_to_full_name=row.reports_to_full_name,
        joining_date=row.joining_date,
        relieving_date=row.relieving_date,
        deactivated_at=row.deactivated_at,
        deactivation_reason=row.deactivation_reason,
    )


def _resolve_department_id(
    conn: Connection,
    scope: TenantScope,
    *,
    department_id: Optional[int],
    department_code: Optional[str],
) -> int:
    """Pick the department id from either field; raise 400 on ambiguity/missing."""

    if department_id is None and department_code is None:
        raise HTTPException(
            status_code=400, detail="department_id or department_code required"
        )
    if department_id is not None:
        dept = repo.get_department_by_id(conn, scope, department_id)
        if dept is None:
            raise HTTPException(status_code=404, detail="department not found")
        return dept.id
    # department_code branch
    assert department_code is not None
    dept = repo.get_department_by_code(conn, scope, department_code)
    if dept is None:
        raise HTTPException(
            status_code=400, detail=f"unknown department code '{department_code}'"
        )
    return dept.id


# --- Endpoints --------------------------------------------------------------


@router.get("", response_model=EmployeeListOut)
def list_employees_endpoint(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    q: Annotated[Optional[str], Query(description="Text search")] = None,
    department_id: Annotated[Optional[int], Query()] = None,
    include_inactive: Annotated[bool, Query()] = False,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> EmployeeListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows, total = repo.list_employees(
            conn,
            scope,
            q=q,
            department_id=department_id,
            include_inactive=include_inactive,
            page=page,
            page_size=page_size,
        )
    return EmployeeListOut(
        items=[_row_to_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/export")
def export_employees_endpoint(user: Annotated[CurrentUser, ADMIN_OR_HR]) -> StreamingResponse:
    """Full-tenant XLSX dump (active + inactive), one sheet named Employees."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_all_for_export(conn, scope)
        # P12: append one column per defined custom field, in
        # display_order. Empty cells where the employee has no value.
        custom_fields = cf_repo.list_fields(conn, scope)
        custom_codes = tuple(f.code for f in custom_fields)
        values_by_employee = cf_repo.values_for_employees(
            conn, scope, [r.id for r in rows]
        )
        # P28.7: build the user_id → email map for the
        # ``reports_to_email`` export column. One query, only the
        # users referenced by these employees' reports_to_user_id.
        from sqlalchemy import select as _select  # noqa: PLC0415

        reports_to_ids = [
            r.reports_to_user_id
            for r in rows
            if r.reports_to_user_id is not None
        ]
        reports_to_email_by_user: dict[int, str] = {}
        if reports_to_ids:
            from hadir.db import users as _users  # noqa: PLC0415

            user_rows = conn.execute(
                _select(_users.c.id, _users.c.email).where(
                    _users.c.tenant_id == scope.tenant_id,
                    _users.c.id.in_(reports_to_ids),
                )
            ).all()
            reports_to_email_by_user = {
                int(u.id): str(u.email) for u in user_rows
            }
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.exported",
            entity_type="employee",
            after={
                "count": len(rows),
                "custom_field_codes": list(custom_codes),
            },
        )

    buf = excel_io.build_export(
        rows,
        custom_field_codes=custom_codes,
        values_by_employee=values_by_employee,
        reports_to_email_by_user=reports_to_email_by_user,
    )
    return StreamingResponse(
        buf,
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={"Content-Disposition": 'attachment; filename="employees.xlsx"'},
    )


@router.post("", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
def create_employee_endpoint(
    payload: EmployeeCreateIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> EmployeeOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    # P28.7: status='inactive' on create requires a reason. The
    # ``EmployeePatchIn`` schema can't enforce this server-side
    # without two-way coupling between fields, so we validate here.
    if payload.status == "inactive":
        reason = (payload.deactivation_reason or "").strip()
        if len(reason) < 5:
            raise HTTPException(
                status_code=400,
                detail="deactivation_reason is required (min 5 chars) when status='inactive'",
            )

    with get_engine().begin() as conn:
        dept_id = _resolve_department_id(
            conn,
            scope,
            department_id=payload.department_id,
            department_code=payload.department_code,
        )

        # Validate ``reports_to_user_id`` belongs to this tenant — guards
        # against cross-tenant ID smuggling via the wire.
        if payload.reports_to_user_id is not None:
            if not repo.is_user_in_tenant(
                conn, scope, payload.reports_to_user_id
            ):
                raise HTTPException(
                    status_code=400,
                    detail="reports_to_user_id is not a user in this tenant",
                )

        # Duplicate employee_code → 409 so callers can tell it apart from
        # malformed input (400s).
        if repo.get_employee_by_code(conn, scope, payload.employee_code) is not None:
            raise HTTPException(
                status_code=409,
                detail=f"employee_code '{payload.employee_code}' already exists",
            )

        deactivated_at = (
            datetime.now(tz=timezone.utc) if payload.status == "inactive" else None
        )

        new_id = repo.create_employee(
            conn,
            scope,
            employee_code=payload.employee_code,
            full_name=payload.full_name,
            email=payload.email,
            department_id=dept_id,
            status=payload.status,
            designation=payload.designation,
            phone=payload.phone,
            reports_to_user_id=payload.reports_to_user_id,
            joining_date=payload.joining_date,
            relieving_date=payload.relieving_date,
            deactivated_at=deactivated_at,
            deactivation_reason=(
                payload.deactivation_reason if payload.status == "inactive" else None
            ),
        )
        created = repo.get_employee(conn, scope, new_id)
        assert created is not None

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.created",
            entity_type="employee",
            entity_id=str(new_id),
            after={
                "employee_code": created.employee_code,
                "full_name": created.full_name,
                "email": created.email,
                "department_code": created.department_code,
                "status": created.status,
                "designation": created.designation,
                "phone": created.phone,
                "reports_to_user_id": created.reports_to_user_id,
                "joining_date": (
                    created.joining_date.isoformat()
                    if created.joining_date
                    else None
                ),
                "relieving_date": (
                    created.relieving_date.isoformat()
                    if created.relieving_date
                    else None
                ),
            },
        )
    return _row_to_out(created)


@router.get("/{employee_id}", response_model=EmployeeOut)
def get_employee_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> EmployeeOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_employee(conn, scope, employee_id)
    if row is None:
        raise HTTPException(status_code=404, detail="employee not found")
    return _row_to_out(row)


@router.patch("/{employee_id}", response_model=EmployeeOut)
def patch_employee_endpoint(
    employee_id: int,
    payload: EmployeePatchIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> EmployeeOut:
    scope = TenantScope(tenant_id=user.tenant_id)

    provided = payload.model_dump(exclude_unset=True)

    with get_engine().begin() as conn:
        before = repo.get_employee(conn, scope, employee_id)
        if before is None:
            raise HTTPException(status_code=404, detail="employee not found")

        # P28.7 cross-field validation against the EXISTING row:
        # - relieving_date must remain >= joining_date even if only
        #   one of the two is provided in the patch.
        new_joining = provided.get("joining_date", before.joining_date)
        new_relieving = provided.get("relieving_date", before.relieving_date)
        if (
            new_joining is not None
            and new_relieving is not None
            and new_relieving < new_joining
        ):
            raise HTTPException(
                status_code=400,
                detail="relieving_date cannot be before joining_date",
            )

        # P28.7 reports_to validation — must be a user in this tenant.
        if "reports_to_user_id" in provided and provided["reports_to_user_id"] is not None:
            if not repo.is_user_in_tenant(
                conn, scope, int(provided["reports_to_user_id"])
            ):
                raise HTTPException(
                    status_code=400,
                    detail="reports_to_user_id is not a user in this tenant",
                )

        # Translate the patch into a column dict. We only include
        # keys the caller actually set, so omitted fields stay untouched.
        values: dict[str, object] = {}

        for key in (
            "full_name",
            "email",
            "designation",
            "phone",
            "reports_to_user_id",
            "joining_date",
            "relieving_date",
        ):
            if key in provided:
                values[key] = provided[key]

        if "department_id" in provided or "department_code" in provided:
            values["department_id"] = _resolve_department_id(
                conn,
                scope,
                department_id=provided.get("department_id"),
                department_code=provided.get("department_code"),
            )

        # P28.7 status flip rules:
        # - active → inactive: requires deactivation_reason (min 5 chars,
        #   trimmed) AND sets deactivated_at = now(). Triggers matcher
        #   cache reload at the end so the next detection lands as a
        #   former-employee match.
        # - inactive → active: clears deactivated_at + deactivation_reason.
        #   Also reloads matcher cache so the next detection lands as
        #   a regular match again.
        status_flipped = False
        if "status" in provided:
            new_status = provided["status"]
            if new_status not in ("active", "inactive"):
                raise HTTPException(
                    status_code=400, detail="status must be 'active' or 'inactive'"
                )
            if new_status != before.status:
                status_flipped = True
                values["status"] = new_status
                if new_status == "inactive":
                    raw_reason = (
                        provided.get("deactivation_reason")
                        or payload.deactivation_reason
                        or ""
                    )
                    reason = str(raw_reason).strip()
                    if len(reason) < 5:
                        raise HTTPException(
                            status_code=400,
                            detail=(
                                "deactivation_reason is required (min 5 chars) "
                                "when status is set to 'inactive'"
                            ),
                        )
                    values["deactivation_reason"] = reason
                    values["deactivated_at"] = datetime.now(tz=timezone.utc)
                else:  # → active
                    values["deactivation_reason"] = None
                    values["deactivated_at"] = None
        elif "deactivation_reason" in provided and before.status == "inactive":
            # Editing the reason while still inactive — keep
            # deactivated_at, just update the text.
            values["deactivation_reason"] = provided["deactivation_reason"]

        repo.update_employee(conn, scope, employee_id, values=values)
        after = repo.get_employee(conn, scope, employee_id)
        assert after is not None

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.updated",
            entity_type="employee",
            entity_id=str(employee_id),
            before={
                "full_name": before.full_name,
                "email": before.email,
                "department_code": before.department_code,
                "status": before.status,
                "designation": before.designation,
                "phone": before.phone,
                "reports_to_user_id": before.reports_to_user_id,
                "joining_date": (
                    before.joining_date.isoformat()
                    if before.joining_date
                    else None
                ),
                "relieving_date": (
                    before.relieving_date.isoformat()
                    if before.relieving_date
                    else None
                ),
                "deactivation_reason": before.deactivation_reason,
            },
            after={
                "full_name": after.full_name,
                "email": after.email,
                "department_code": after.department_code,
                "status": after.status,
                "designation": after.designation,
                "phone": after.phone,
                "reports_to_user_id": after.reports_to_user_id,
                "joining_date": (
                    after.joining_date.isoformat()
                    if after.joining_date
                    else None
                ),
                "relieving_date": (
                    after.relieving_date.isoformat()
                    if after.relieving_date
                    else None
                ),
                "deactivation_reason": after.deactivation_reason,
            },
        )

    # Cache reload happens AFTER the transaction commits — otherwise a
    # rollback would leave the cache out of sync with the row.
    if status_flipped:
        matcher_cache.invalidate_employee(employee_id)

    return _row_to_out(after)


@router.delete("/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete_employee_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    response: Response,
) -> Response:
    """Soft delete (legacy) — sets ``status='inactive'``.

    P28.7: prefer the delete-request workflow at
    ``POST /api/employees/{id}/delete-request`` for hard-delete with
    HR approval. This endpoint stays for backward compat + bulk
    soft-deactivation scripts; it does NOT remove crops or rows.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = repo.get_employee(conn, scope, employee_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="employee not found")
        if existing.status == "inactive":
            # Idempotent — DELETE on an already-deleted row is a no-op
            # but we still audit so operators can trace repeated attempts.
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="employee.soft_deleted",
                entity_type="employee",
                entity_id=str(employee_id),
                after={"noop": True, "employee_code": existing.employee_code},
            )
        else:
            repo.soft_delete_employee(conn, scope, employee_id)
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="employee.soft_deleted",
                entity_type="employee",
                entity_id=str(employee_id),
                before={"status": existing.status},
                after={"status": "inactive", "employee_code": existing.employee_code},
            )

    response.status_code = status.HTTP_204_NO_CONTENT
    return response


# ---- PDPL delete-on-request (v1.0 P25) -----------------------------
#
# BRD NFR-COMP-003 + FR-EMP-009. Admin-only. Requires a typed
# confirmation phrase in the body — same shape as the restore
# script's typed RESTORE prompt, except machine-readable so the
# UI can render a "type the phrase" modal.

from pydantic import BaseModel, Field as _PydField  # noqa: E402


class PdplDeleteRequest(BaseModel):
    confirmation: str = _PydField(
        ...,
        description=(
            "Operator-typed confirmation phrase. Must equal "
            f"{pdpl_module.PDPL_CONFIRMATION_PHRASE!r}."
        ),
        max_length=64,
    )


class PdplDeleteResponse(BaseModel):
    employee_id: int
    photo_rows_deleted: int
    photo_files_deleted: int
    custom_field_values_deleted: int
    status: str = "deleted"


@router.post(
    "/{employee_id}/gdpr-delete",
    response_model=PdplDeleteResponse,
    status_code=status.HTTP_200_OK,
)
def pdpl_delete_employee_endpoint(
    employee_id: int,
    payload: PdplDeleteRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> PdplDeleteResponse:
    """PDPL right-to-erasure for a single employee.

    Drops every photo (file + DB row), every custom_field_values
    row, redacts ``full_name`` to ``[deleted]`` + ``email`` to
    ``deleted-{id}@hadir.local``, and flips ``status='deleted'``.
    Attendance, audit, and request rows stay (verifiable history
    per BRD NFR-RET-004).

    The confirmation phrase is the brake — a sloppy curl can't
    accidentally invoke this endpoint. The phrase is exposed
    via ``hadir.employees.pdpl.PDPL_CONFIRMATION_PHRASE`` for
    the UI to render verbatim.
    """

    if payload.confirmation != pdpl_module.PDPL_CONFIRMATION_PHRASE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "confirmation phrase did not match (case + whitespace "
                "sensitive)"
            ),
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        try:
            result = pdpl_module.pdpl_delete_employee(
                conn,
                scope,
                employee_id=employee_id,
                actor_user_id=user.id,
                confirmation_phrase=payload.confirmation,
            )
        except ValueError as exc:
            msg = str(exc)
            if "not found" in msg:
                raise HTTPException(status_code=404, detail=msg) from exc
            raise HTTPException(status_code=409, detail=msg) from exc

    return PdplDeleteResponse(
        employee_id=result.employee_id,
        photo_rows_deleted=result.photo_rows_deleted,
        photo_files_deleted=result.photo_files_deleted,
        custom_field_values_deleted=result.custom_field_values_deleted,
    )


@router.post("/import", response_model=ImportResult)
async def import_employees_endpoint(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    file: UploadFile = File(...),
) -> ImportResult:
    """Upsert employees from an XLSX. Per-row errors are collected, not fatal."""

    scope = TenantScope(tenant_id=user.tenant_id)
    data = await file.read()
    engine = get_engine()

    created = 0
    updated = 0
    errors: list[ImportErrorSchema] = []
    warnings: list[ImportWarningSchema] = []
    seen_codes: set[str] = set()

    try:
        rows = list(excel_io.parse_import(BytesIO(data)))
    except excel_io.ImportParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # P12: snapshot custom-field defs once. Unknown header codes turn
    # into row warnings; known codes coerce per type and upsert.
    with engine.begin() as conn:
        custom_field_defs = {
            f.code: f for f in cf_repo.list_fields(conn, scope)
        }

    for row in rows:
        # Basic per-row validation first so we don't waste a transaction.
        if not row.employee_code:
            errors.append(
                ImportErrorSchema(row=row.excel_row, message="employee_code is required")
            )
            continue
        if not row.full_name:
            errors.append(
                ImportErrorSchema(row=row.excel_row, message="full_name is required")
            )
            continue
        if not row.department_code:
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row, message="department_code is required"
                )
            )
            continue
        if row.employee_code in seen_codes:
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row,
                    message=(
                        f"duplicate employee_code '{row.employee_code}' "
                        "earlier in file"
                    ),
                )
            )
            continue
        seen_codes.add(row.employee_code)

        # P28.7 — date parsing happens before the transaction so a
        # malformed cell becomes a per-row error without rolling back
        # anything else.
        try:
            joining = excel_io.parse_iso_date(row.joining_date)
        except ValueError:
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row,
                    message=f"invalid joining_date {row.joining_date!r} (use YYYY-MM-DD)",
                )
            )
            continue
        try:
            relieving = excel_io.parse_iso_date(row.relieving_date)
        except ValueError:
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row,
                    message=f"invalid relieving_date {row.relieving_date!r} (use YYYY-MM-DD)",
                )
            )
            continue
        if joining is not None and relieving is not None and relieving < joining:
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row,
                    message="relieving_date is before joining_date",
                )
            )
            continue

        # One transaction per row keeps the audit log accurate (a later
        # row's DB error doesn't roll back an earlier row's audit write)
        # and matches the partial-success contract of the response shape.
        try:
            with engine.begin() as conn:
                dept = repo.get_department_by_code(conn, scope, row.department_code)
                if dept is None:
                    # Raise to break out of the ``with`` and land in except.
                    raise _RowError(
                        f"unknown department_code '{row.department_code}'"
                    )

                # P28.7: resolve reports_to_email → user_id within the
                # tenant. Unknown email is a per-row error so the
                # operator can fix the spelling without losing the rest
                # of the file.
                reports_to_id: Optional[int] = None
                if row.reports_to_email:
                    from sqlalchemy import select as _select  # noqa: PLC0415
                    from hadir.db import users as _users  # noqa: PLC0415

                    user_row = conn.execute(
                        _select(_users.c.id).where(
                            _users.c.tenant_id == scope.tenant_id,
                            func.lower(_users.c.email)
                            == row.reports_to_email.strip().lower(),
                        )
                    ).first()
                    if user_row is None:
                        raise _RowError(
                            f"unknown reports_to_email '{row.reports_to_email}'"
                        )
                    reports_to_id = int(user_row.id)

                existing = repo.get_employee_by_code(conn, scope, row.employee_code)
                if existing is None:
                    new_id = repo.create_employee(
                        conn,
                        scope,
                        employee_code=row.employee_code,
                        full_name=row.full_name,
                        email=row.email,
                        department_id=dept.id,
                        designation=row.designation,
                        phone=row.phone,
                        reports_to_user_id=reports_to_id,
                        joining_date=joining,
                        relieving_date=relieving,
                    )
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="employee.created",
                        entity_type="employee",
                        entity_id=str(new_id),
                        after={
                            "employee_code": row.employee_code,
                            "full_name": row.full_name,
                            "email": row.email,
                            "department_code": row.department_code,
                            "designation": row.designation,
                            "phone": row.phone,
                            "reports_to_user_id": reports_to_id,
                            "joining_date": joining.isoformat() if joining else None,
                            "relieving_date": relieving.isoformat() if relieving else None,
                            "source": "import",
                        },
                    )
                    created += 1
                    target_employee_id = new_id
                else:
                    update_values: dict[str, object] = {
                        "full_name": row.full_name,
                        "email": row.email,
                        "department_id": dept.id,
                    }
                    # Only set the new fields when the row actually
                    # provides a value — empty cells leave the existing
                    # value alone (the import is upsert-friendly).
                    if row.designation is not None:
                        update_values["designation"] = row.designation
                    if row.phone is not None:
                        update_values["phone"] = row.phone
                    if row.reports_to_email is not None:
                        update_values["reports_to_user_id"] = reports_to_id
                    if joining is not None:
                        update_values["joining_date"] = joining
                    if relieving is not None:
                        update_values["relieving_date"] = relieving

                    repo.update_employee(
                        conn, scope, existing.id, values=update_values
                    )
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="employee.updated",
                        entity_type="employee",
                        entity_id=str(existing.id),
                        before={
                            "full_name": existing.full_name,
                            "email": existing.email,
                            "department_code": existing.department_code,
                        },
                        after={
                            "full_name": row.full_name,
                            "email": row.email,
                            "department_code": row.department_code,
                            "designation": row.designation,
                            "phone": row.phone,
                            "reports_to_user_id": reports_to_id,
                            "joining_date": joining.isoformat() if joining else None,
                            "relieving_date": relieving.isoformat() if relieving else None,
                            "source": "import",
                        },
                    )
                    updated += 1
                    target_employee_id = existing.id

                # P12: apply custom-field values from the row. Unknown
                # codes are warnings (operator left a stale column),
                # coerce failures are warnings (the standard columns
                # already imported, the bad cell is just skipped).
                for raw_code, raw_value in row.custom_values.items():
                    field_def = custom_field_defs.get(raw_code)
                    if field_def is None:
                        warnings.append(
                            ImportWarningSchema(
                                row=row.excel_row,
                                message=(
                                    f"unknown custom field column "
                                    f"{raw_code!r} — value ignored"
                                ),
                            )
                        )
                        continue
                    try:
                        stored = cf_repo.coerce_for_store(field_def, raw_value)
                    except cf_repo.CoerceError as exc:
                        warnings.append(
                            ImportWarningSchema(
                                row=row.excel_row, message=str(exc)
                            )
                        )
                        continue
                    if stored == "":
                        cf_repo.clear_value(
                            conn,
                            scope,
                            employee_id=target_employee_id,
                            field_id=field_def.id,
                        )
                    else:
                        cf_repo.upsert_value(
                            conn,
                            scope,
                            employee_id=target_employee_id,
                            field_id=field_def.id,
                            value=stored,
                        )
        except _RowError as exc:
            errors.append(ImportErrorSchema(row=row.excel_row, message=str(exc)))
        except Exception as exc:  # noqa: BLE001
            # Swallow per-row DB errors and keep going; the operator sees
            # the row/message in the response. Unlogged fields (password,
            # RTSP URL) can't surface here because we never pass them.
            logger.warning("import row %d failed: %s", row.excel_row, exc)
            errors.append(
                ImportErrorSchema(row=row.excel_row, message="could not save row")
            )

    # One summary audit row with the counts — useful for an "audit log
    # shows X imported Y rows on Z date" query without scanning every
    # employee.* row.
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.imported",
            entity_type="employee",
            after={
                "created": created,
                "updated": updated,
                "errors": len(errors),
                "warnings": len(warnings),
                "filename": file.filename,
            },
        )

    return ImportResult(
        created=created, updated=updated, errors=errors, warnings=warnings
    )


class _RowError(Exception):
    """Internal signal used by the import loop to hand a message back to the caller."""


# ---------------------------------------------------------------------------
# Photo ingestion (P6)
# ---------------------------------------------------------------------------
# The `/photos/bulk` route is registered BEFORE the
# `/{employee_id}/photos*` routes so FastAPI's matcher picks the static
# path first; it also uses the `photos_io` module for Fernet + disk I/O.


def _drop_file(path_str: str) -> None:
    """Remove a stored photo from disk, swallowing "already gone" errors."""

    from pathlib import Path

    try:
        Path(path_str).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("could not remove photo file %s: %s", path_str, exc)


@router.post("/photos/bulk", response_model=PhotoIngestResult)
async def bulk_ingest_photos_endpoint(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    files: list[UploadFile] = File(...),
) -> PhotoIngestResult:
    """Folder-dump ingest — filenames encode the ``employee_code`` and angle.

    PROJECT_CONTEXT §3 convention:
      - ``OM0097.jpg`` → angle=front
      - ``OM0097_front.jpg`` / ``_left.jpg`` / ``_right.jpg`` / ``_other.jpg``

    An unmatched ``employee_code`` is a **rejection**, never an
    auto-create. Rejections are audited so operators can reconcile.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    accepted: list[PhotoIngestAccepted] = []
    rejected: list[PhotoIngestRejected] = []

    for upload in files:
        raw_name = upload.filename or ""
        parsed = photos_io.parse_filename(raw_name)
        if parsed is None:
            rejected.append(
                PhotoIngestRejected(
                    filename=raw_name,
                    reason=(
                        "filename does not match OM0097[_front|_left|_right|_other].jpg"
                    ),
                )
            )
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=scope.tenant_id,
                    actor_user_id=user.id,
                    action="photo.rejected",
                    entity_type="photo",
                    after={"filename": raw_name, "reason": "bad_filename"},
                )
            continue

        data = await upload.read()

        with engine.begin() as conn:
            emp = repo.get_employee_by_code(conn, scope, parsed.employee_code)

        if emp is None:
            rejected.append(
                PhotoIngestRejected(
                    filename=raw_name,
                    reason=f"unknown employee_code '{parsed.employee_code}'",
                )
            )
            with engine.begin() as conn:
                write_audit(
                    conn,
                    tenant_id=scope.tenant_id,
                    actor_user_id=user.id,
                    action="photo.rejected",
                    entity_type="photo",
                    after={
                        "filename": raw_name,
                        "employee_code": parsed.employee_code,
                        "reason": "unknown_employee",
                    },
                )
            continue

        try:
            file_path = photos_io.write_encrypted(
                scope.tenant_id, emp.employee_code, parsed.angle, data
            )
        except Exception as exc:
            logger.warning("photo write failed for %s: %s", raw_name, exc)
            rejected.append(
                PhotoIngestRejected(filename=raw_name, reason="could not store file")
            )
            continue

        with engine.begin() as conn:
            photo_id = photos_io.create_photo_row(
                conn,
                scope,
                employee_id=emp.id,
                angle=parsed.angle,
                file_path=file_path,
                approved_by_user_id=user.id,
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="photo.ingested",
                entity_type="photo",
                entity_id=str(photo_id),
                after={
                    "employee_id": emp.id,
                    "employee_code": emp.employee_code,
                    "angle": parsed.angle,
                    "source": "bulk",
                    "filename": raw_name,
                },
            )

        accepted.append(
            PhotoIngestAccepted(
                filename=raw_name,
                employee_code=emp.employee_code,
                angle=parsed.angle,  # type: ignore[arg-type]
                photo_id=photo_id,
            )
        )
        # Best-effort enrollment — failures here don't fail the upload.
        # ``enroll_photo`` itself invalidates the matcher cache for the
        # affected employee on success.
        try:
            id_enrollment.enroll_photo(engine, scope, photo_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "enrollment after bulk upload failed for photo %s: %s",
                photo_id,
                type(exc).__name__,
            )

    return PhotoIngestResult(accepted=accepted, rejected=rejected)


@router.post("/{employee_id}/photos", response_model=PhotoIngestResult)
async def upload_photos_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    files: list[UploadFile] = File(...),
    angle: Annotated[str, Form()] = photos_io.DEFAULT_ANGLE,
) -> PhotoIngestResult:
    """Upload one or more reference photos against an employee. Admin or HR."""
    """Upload one or more images against a specific employee.

    ``angle`` is a single form field applied to every file in this
    request (drawer UX — the operator picks the angle once). For
    mixed-angle folder dumps use ``/api/employees/photos/bulk`` instead.
    """

    if angle not in photos_io.ALLOWED_ANGLES:
        raise HTTPException(
            status_code=400, detail=f"invalid angle '{angle}'"
        )

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    with engine.begin() as conn:
        emp = repo.get_employee(conn, scope, employee_id)

    if emp is None:
        raise HTTPException(status_code=404, detail="employee not found")

    accepted: list[PhotoIngestAccepted] = []
    rejected: list[PhotoIngestRejected] = []

    for upload in files:
        raw_name = upload.filename or "upload.jpg"
        data = await upload.read()
        if not data:
            rejected.append(PhotoIngestRejected(filename=raw_name, reason="empty file"))
            continue

        try:
            file_path = photos_io.write_encrypted(
                scope.tenant_id, emp.employee_code, angle, data
            )
        except Exception as exc:
            logger.warning("photo write failed for %s: %s", raw_name, exc)
            rejected.append(
                PhotoIngestRejected(filename=raw_name, reason="could not store file")
            )
            continue

        with engine.begin() as conn:
            photo_id = photos_io.create_photo_row(
                conn,
                scope,
                employee_id=emp.id,
                angle=angle,
                file_path=file_path,
                approved_by_user_id=user.id,
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="photo.ingested",
                entity_type="photo",
                entity_id=str(photo_id),
                after={
                    "employee_id": emp.id,
                    "employee_code": emp.employee_code,
                    "angle": angle,
                    "source": "drawer",
                    "filename": raw_name,
                },
            )

        accepted.append(
            PhotoIngestAccepted(
                filename=raw_name,
                employee_code=emp.employee_code,
                angle=angle,  # type: ignore[arg-type]
                photo_id=photo_id,
            )
        )
        try:
            id_enrollment.enroll_photo(engine, scope, photo_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "enrollment after drawer upload failed for photo %s: %s",
                photo_id,
                type(exc).__name__,
            )

    return PhotoIngestResult(accepted=accepted, rejected=rejected)


@router.get("/{employee_id}/photos", response_model=PhotoListOut)
def list_photos_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> PhotoListOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        emp = repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")
        rows = photos_io.list_photos_for_employee(conn, scope, employee_id)
    return PhotoListOut(
        items=[
            PhotoOut(id=r.id, employee_id=r.employee_id, angle=r.angle)  # type: ignore[arg-type]
            for r in rows
        ]
    )


@router.get("/{employee_id}/photos/{photo_id}/image")
def get_photo_image_endpoint(
    employee_id: int,
    photo_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> Response:
    """Decrypt and stream the stored image bytes (auth-gated, audited)."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = photos_io.get_photo(
            conn, scope, photo_id=photo_id, employee_id=employee_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="photo not found")
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="photo.viewed",
            entity_type="photo",
            entity_id=str(photo_id),
            after={"employee_id": employee_id, "angle": row.angle},
        )

    try:
        plain = photos_io.read_decrypted(row.file_path)
    except (FileNotFoundError, RuntimeError) as exc:
        logger.warning("photo read failed for id=%s: %s", photo_id, exc)
        raise HTTPException(status_code=500, detail="could not read photo") from exc

    return Response(content=plain, media_type="image/jpeg")


@router.delete(
    "/{employee_id}/photos/{photo_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_photo_endpoint(
    employee_id: int,
    photo_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    response: Response,
) -> Response:
    """Remove the DB row and best-effort delete the encrypted file on disk."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = photos_io.get_photo(
            conn, scope, photo_id=photo_id, employee_id=employee_id
        )
        if row is None:
            raise HTTPException(status_code=404, detail="photo not found")
        photos_io.delete_photo_row(conn, scope, photo_id=photo_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="photo.deleted",
            entity_type="photo",
            entity_id=str(photo_id),
            before={"angle": row.angle, "file_path": row.file_path},
            after={"employee_id": employee_id},
        )

    _drop_file(row.file_path)
    # Invalidate the matcher cache so we don't keep matching against a
    # deleted embedding.
    matcher_cache.invalidate_employee(employee_id)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
