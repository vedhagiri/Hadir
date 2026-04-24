"""FastAPI router for ``/api/employees/*`` (Admin-only in the pilot).

Every CRUD operation writes an audit row via the append-only ``write_audit``
helper; the import path also writes a summary row with the import counts.
HR read access (and Employee self-access on /me) land in later prompts.
"""

from __future__ import annotations

import logging
from io import BytesIO
from typing import Annotated, Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.engine import Connection

from hadir.auth.audit import write_audit
from hadir.auth.dependencies import CurrentUser, require_role
from hadir.db import get_engine
from hadir.employees import excel as excel_io
from hadir.employees import repository as repo
from hadir.employees.schemas import (
    EmployeeCreateIn,
    EmployeeListOut,
    EmployeeOut,
    EmployeePatchIn,
    ImportError as ImportErrorSchema,
    ImportResult,
)
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/employees", tags=["employees"])

# Pilot is Admin-only. HR read access opens up in a later prompt; until
# then we import the guard once and reuse it as ``ADMIN`` so the route
# definitions below read like documentation.
ADMIN = Depends(require_role("Admin"))


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
        status=row.status,  # type: ignore[arg-type]  -- DB CHECK limits to active|inactive
        photo_count=row.photo_count,
        created_at=row.created_at,
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
    user: Annotated[CurrentUser, ADMIN],
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
def export_employees_endpoint(user: Annotated[CurrentUser, ADMIN]) -> StreamingResponse:
    """Full-tenant XLSX dump (active + inactive), one sheet named Employees."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = repo.list_all_for_export(conn, scope)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.exported",
            entity_type="employee",
            after={"count": len(rows)},
        )

    buf = excel_io.build_export(rows)
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
    user: Annotated[CurrentUser, ADMIN],
) -> EmployeeOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        dept_id = _resolve_department_id(
            conn,
            scope,
            department_id=payload.department_id,
            department_code=payload.department_code,
        )

        # Duplicate employee_code → 409 so callers can tell it apart from
        # malformed input (400s).
        if repo.get_employee_by_code(conn, scope, payload.employee_code) is not None:
            raise HTTPException(
                status_code=409,
                detail=f"employee_code '{payload.employee_code}' already exists",
            )

        new_id = repo.create_employee(
            conn,
            scope,
            employee_code=payload.employee_code,
            full_name=payload.full_name,
            email=payload.email,
            department_id=dept_id,
            status=payload.status,
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
            },
        )
    return _row_to_out(created)


@router.get("/{employee_id}", response_model=EmployeeOut)
def get_employee_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN],
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
    user: Annotated[CurrentUser, ADMIN],
) -> EmployeeOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        before = repo.get_employee(conn, scope, employee_id)
        if before is None:
            raise HTTPException(status_code=404, detail="employee not found")

        # Translate the Pydantic patch into a column dict. We only include
        # keys the caller actually set, so omitted fields stay untouched.
        values: dict[str, object] = {}
        provided = payload.model_dump(exclude_unset=True)

        if "full_name" in provided:
            values["full_name"] = provided["full_name"]
        if "email" in provided:
            values["email"] = provided["email"]
        if "status" in provided:
            values["status"] = provided["status"]
        if "department_id" in provided or "department_code" in provided:
            values["department_id"] = _resolve_department_id(
                conn,
                scope,
                department_id=provided.get("department_id"),
                department_code=provided.get("department_code"),
            )

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
            },
            after={
                "full_name": after.full_name,
                "email": after.email,
                "department_code": after.department_code,
                "status": after.status,
            },
        )
    return _row_to_out(after)


@router.delete("/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete_employee_endpoint(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    """Soft delete. Hard delete is PDPL-only and not exposed in the pilot."""

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


@router.post("/import", response_model=ImportResult)
async def import_employees_endpoint(
    user: Annotated[CurrentUser, ADMIN],
    file: UploadFile = File(...),
) -> ImportResult:
    """Upsert employees from an XLSX. Per-row errors are collected, not fatal."""

    scope = TenantScope(tenant_id=user.tenant_id)
    data = await file.read()
    engine = get_engine()

    created = 0
    updated = 0
    errors: list[ImportErrorSchema] = []
    seen_codes: set[str] = set()

    try:
        rows = list(excel_io.parse_import(BytesIO(data)))
    except excel_io.ImportParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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

                existing = repo.get_employee_by_code(conn, scope, row.employee_code)
                if existing is None:
                    new_id = repo.create_employee(
                        conn,
                        scope,
                        employee_code=row.employee_code,
                        full_name=row.full_name,
                        email=row.email,
                        department_id=dept.id,
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
                            "source": "import",
                        },
                    )
                    created += 1
                else:
                    repo.update_employee(
                        conn,
                        scope,
                        existing.id,
                        values={
                            "full_name": row.full_name,
                            "email": row.email,
                            "department_id": dept.id,
                        },
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
                            "source": "import",
                        },
                    )
                    updated += 1
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
                "filename": file.filename,
            },
        )

    return ImportResult(created=created, updated=updated, errors=errors)


class _RowError(Exception):
    """Internal signal used by the import loop to hand a message back to the caller."""
