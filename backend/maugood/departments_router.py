"""Tenant-scoped departments management.

Pilot seeded three departments per tenant (ENG/OPS/ADM) and the v1.0
``provision_tenant.py`` CLI does the same. Until now there was no
runtime CRUD — operators had to edit seeds or run SQL to add or
rename a department, and the Employee Add drawer had a HARDCODED
list of three pilot departments.

Operator ask: depts should be managed separately so the Add /
Import flow can just SELECT from the live list. This module
exposes the four CRUD endpoints + an audit row per mutation.

Read access is open to every authenticated role (Admin, HR,
Manager, Employee) — picking a department is part of the basic
employee profile flow. Mutation is gated to Admin or HR; an
HR-flipped department change still lands in the audit trail.

Hard-delete refuses when at least one ``employees`` row references
the department. The operator must move/soft-delete the affected
employees first; this is the safer default than ON DELETE CASCADE
(which would orphan attendance + photos).
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete as sql_delete, func, insert, select, update

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    current_user,
    require_any_role,
)
from maugood.db import (
    departments,
    divisions,
    employees,
    get_engine,
    roles,
    user_departments,
    user_roles,
    users,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/departments", tags=["departments"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
AUTH = Depends(current_user)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


# Department codes flow through Excel import + appear in audit rows;
# constrain to a stable shape (uppercase letters/digits/underscore,
# 1-16 chars) so an operator can type ENG into a Excel column without
# worrying about case-folding or trimming.
_CODE_RE = re.compile(r"^[A-Z0-9_]{1,16}$")


class DepartmentOut(BaseModel):
    id: int
    code: str
    name: str
    employee_count: int
    # P29 (#3): top-tier hierarchy. None when not assigned to a
    # division — operator can backfill via PATCH.
    division_id: Optional[int] = None
    division_code: Optional[str] = None
    division_name: Optional[str] = None


class DepartmentListOut(BaseModel):
    items: list[DepartmentOut]


class DepartmentCreateIn(BaseModel):
    code: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=2, max_length=120)
    division_id: Optional[int] = None

    @field_validator("code")
    @classmethod
    def _validate_code(cls, v: str) -> str:
        upper = v.strip().upper()
        if not _CODE_RE.match(upper):
            raise ValueError(
                "code must be 1-16 chars of A-Z, 0-9, underscore"
            )
        return upper

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return v.strip()


class DepartmentPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    # ``code`` is intentionally not editable — Excel imports + audit
    # rows reference it. Renaming the display name is fine; renaming
    # the code is a follow-up because it changes the import contract.
    # ``division_id`` is editable (use ``None`` to clear).
    division_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if v is not None else None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _list_with_counts(scope: TenantScope) -> list[DepartmentOut]:
    engine = get_engine()
    with engine.begin() as conn:
        rows = conn.execute(
            select(
                departments.c.id,
                departments.c.code,
                departments.c.name,
                departments.c.division_id,
                divisions.c.code.label("division_code"),
                divisions.c.name.label("division_name"),
                func.count(employees.c.id).label("employee_count"),
            )
            .select_from(
                departments.outerjoin(
                    divisions,
                    (divisions.c.id == departments.c.division_id)
                    & (divisions.c.tenant_id == departments.c.tenant_id),
                ).outerjoin(
                    employees,
                    (employees.c.department_id == departments.c.id)
                    & (employees.c.tenant_id == departments.c.tenant_id)
                    & (employees.c.status != "deleted"),
                )
            )
            .where(departments.c.tenant_id == scope.tenant_id)
            .group_by(
                departments.c.id,
                departments.c.code,
                departments.c.name,
                departments.c.division_id,
                divisions.c.code,
                divisions.c.name,
            )
            .order_by(departments.c.code.asc())
        ).all()
    return [
        DepartmentOut(
            id=int(r.id),
            code=str(r.code),
            name=str(r.name),
            employee_count=int(r.employee_count or 0),
            division_id=int(r.division_id) if r.division_id else None,
            division_code=str(r.division_code) if r.division_code else None,
            division_name=str(r.division_name) if r.division_name else None,
        )
        for r in rows
    ]


@router.get("", response_model=DepartmentListOut)
def list_departments(user: Annotated[CurrentUser, AUTH]) -> DepartmentListOut:
    """List the tenant's departments. Read open to every role — the
    Employee Add drawer's department picker needs this."""

    scope = TenantScope(tenant_id=user.tenant_id)
    return DepartmentListOut(items=_list_with_counts(scope))


@router.post(
    "",
    response_model=DepartmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_department(
    payload: DepartmentCreateIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DepartmentOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        # Duplicate-code guard. The unique index on (tenant_id, code)
        # would also catch this, but a clean 409 with a named field
        # is friendlier than a 500 from a constraint violation.
        existing = conn.execute(
            select(departments.c.id).where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.code == payload.code,
            )
        ).first()
        if existing is not None:
            raise HTTPException(
                status_code=409,
                detail={"field": "code", "message": "code already exists"},
            )
        # Validate division_id (when present) exists in this tenant.
        if payload.division_id is not None:
            div_exists = conn.execute(
                select(divisions.c.id).where(
                    divisions.c.tenant_id == scope.tenant_id,
                    divisions.c.id == payload.division_id,
                )
            ).first()
            if div_exists is None:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "field": "division_id",
                        "message": "division not found",
                    },
                )
        new_id = conn.execute(
            insert(departments)
            .values(
                tenant_id=scope.tenant_id,
                code=payload.code,
                name=payload.name,
                division_id=payload.division_id,
            )
            .returning(departments.c.id)
        ).scalar_one()
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="department.created",
            entity_type="department",
            entity_id=str(new_id),
            after={
                "code": payload.code,
                "name": payload.name,
                "division_id": payload.division_id,
            },
        )
    logger.info(
        "department created: id=%s code=%s by_user=%s",
        new_id,
        payload.code,
        user.id,
    )
    # Return the full row including a 0 employee_count.
    return DepartmentOut(
        id=int(new_id),
        code=payload.code,
        name=payload.name,
        employee_count=0,
        division_id=payload.division_id,
    )


@router.patch("/{department_id}", response_model=DepartmentOut)
def patch_department(
    department_id: int,
    payload: DepartmentPatchIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DepartmentOut:
    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    # ``division_id`` opt-in semantics: ``None`` in the payload means
    # "leave it as-is", not "clear it". To explicitly clear, pass a
    # sentinel via the wire — but Pydantic's default-None makes that
    # impossible without a separate model. Operators clearing a
    # division will be rare (you usually move dept to another
    # division, not orphan it), so we trade that off in favour of
    # the simpler API. To clear, the operator can re-issue PATCH
    # with the new division — or DELETE + recreate if they really
    # want a NULL.
    payload_data = payload.model_dump(exclude_unset=True)
    with engine.begin() as conn:
        before = conn.execute(
            select(
                departments.c.id,
                departments.c.code,
                departments.c.name,
                departments.c.division_id,
            ).where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.id == department_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="department not found")
        values: dict = {}
        if payload.name is not None:
            values["name"] = payload.name
        if "division_id" in payload_data:
            new_div = payload_data["division_id"]
            if new_div is not None:
                div_exists = conn.execute(
                    select(divisions.c.id).where(
                        divisions.c.tenant_id == scope.tenant_id,
                        divisions.c.id == new_div,
                    )
                ).first()
                if div_exists is None:
                    raise HTTPException(
                        status_code=422,
                        detail={
                            "field": "division_id",
                            "message": "division not found",
                        },
                    )
            values["division_id"] = new_div
        if values:
            conn.execute(
                update(departments)
                .where(
                    departments.c.tenant_id == scope.tenant_id,
                    departments.c.id == department_id,
                )
                .values(**values)
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="department.updated",
                entity_type="department",
                entity_id=str(department_id),
                before={
                    "code": str(before.code),
                    "name": str(before.name),
                    "division_id": (
                        int(before.division_id) if before.division_id else None
                    ),
                },
                after={
                    "code": str(before.code),
                    "name": values.get("name", str(before.name)),
                    "division_id": values.get(
                        "division_id",
                        int(before.division_id) if before.division_id else None,
                    ),
                },
            )
    new_division_id = values.get(
        "division_id", int(before.division_id) if before.division_id else None
    )
    return DepartmentOut(
        id=int(before.id),
        code=str(before.code),
        name=values.get("name", str(before.name)),
        employee_count=_count_employees(scope, department_id),
        division_id=new_division_id,
    )


@router.delete(
    "/{department_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_department(
    department_id: int, user: Annotated[CurrentUser, ADMIN_OR_HR]
) -> None:
    """Hard-delete. Refuses with 409 when at least one employee row
    still references the department — the operator must move those
    employees first. This is the safer default than ON DELETE
    CASCADE which would orphan attendance + photos."""

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        before = conn.execute(
            select(departments.c.code, departments.c.name).where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.id == department_id,
            )
        ).first()
        if before is None:
            raise HTTPException(status_code=404, detail="department not found")
        in_use = conn.execute(
            select(func.count())
            .select_from(employees)
            .where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.department_id == department_id,
                employees.c.status != "deleted",
            )
        ).scalar_one()
        if int(in_use) > 0:
            raise HTTPException(
                status_code=409,
                detail={
                    "field": "department_id",
                    "message": (
                        f"{in_use} employee(s) still reference this "
                        "department; move them first"
                    ),
                },
            )
        conn.execute(
            sql_delete(departments).where(
                departments.c.tenant_id == scope.tenant_id,
                departments.c.id == department_id,
            )
        )
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="department.deleted",
            entity_type="department",
            entity_id=str(department_id),
            before={"code": str(before.code), "name": str(before.name)},
        )


# ---------------------------------------------------------------------------
# Bulk import (CSV)
# ---------------------------------------------------------------------------


class DepartmentImportRow(BaseModel):
    row: int
    code: str
    name: str
    status: str  # "created" | "updated" | "error"
    error: Optional[str] = None


class DepartmentImportResult(BaseModel):
    created: int
    updated: int
    errors: int
    rows: list[DepartmentImportRow]


@router.post("/import", response_model=DepartmentImportResult)
def import_departments(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    file: UploadFile = File(...),
) -> DepartmentImportResult:
    """Bulk-import departments from CSV.

    Format: a header row with ``code,name`` columns (extra columns
    ignored). Each subsequent row is upserted by ``code`` —
    existing departments get their name updated, new codes are
    created. Per-row failures (bad code shape, etc.) are reported in
    the response without rolling back the whole import. Audits as
    ``department.imported`` with the row counts.
    """

    import csv  # noqa: PLC0415
    from io import StringIO  # noqa: PLC0415

    raw = file.file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail={"field": "file", "message": "file must be UTF-8 encoded"},
        )
    reader = csv.DictReader(StringIO(text))
    if reader.fieldnames is None or not (
        "code" in [h.strip().lower() for h in reader.fieldnames]
        and "name" in [h.strip().lower() for h in reader.fieldnames]
    ):
        raise HTTPException(
            status_code=400,
            detail={
                "field": "file",
                "message": "CSV must have headers: code,name",
            },
        )
    # Normalise header keys to lowercase so we can read regardless of
    # the operator's casing in the file.
    field_lookup = {h.strip().lower(): h for h in reader.fieldnames}

    scope = TenantScope(tenant_id=user.tenant_id)
    rows: list[DepartmentImportRow] = []
    created = updated = errors = 0
    engine = get_engine()

    for idx, raw_row in enumerate(reader, start=2):  # start=2 → row 1 is header
        raw_code = (raw_row.get(field_lookup["code"], "") or "").strip()
        raw_name = (raw_row.get(field_lookup["name"], "") or "").strip()
        if not raw_code or not raw_name:
            errors += 1
            rows.append(
                DepartmentImportRow(
                    row=idx,
                    code=raw_code,
                    name=raw_name,
                    status="error",
                    error="code and name are required",
                )
            )
            continue
        try:
            payload = DepartmentCreateIn(code=raw_code, name=raw_name)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            rows.append(
                DepartmentImportRow(
                    row=idx,
                    code=raw_code,
                    name=raw_name,
                    status="error",
                    error=str(exc.errors()[0]["msg"])
                    if hasattr(exc, "errors")
                    else str(exc),
                )
            )
            continue

        try:
            with engine.begin() as conn:
                existing = conn.execute(
                    select(departments.c.id, departments.c.name).where(
                        departments.c.tenant_id == scope.tenant_id,
                        departments.c.code == payload.code,
                    )
                ).first()
                if existing is not None:
                    if str(existing.name) != payload.name:
                        conn.execute(
                            update(departments)
                            .where(
                                departments.c.tenant_id == scope.tenant_id,
                                departments.c.id == int(existing.id),
                            )
                            .values(name=payload.name)
                        )
                    updated += 1
                    rows.append(
                        DepartmentImportRow(
                            row=idx,
                            code=payload.code,
                            name=payload.name,
                            status="updated",
                        )
                    )
                else:
                    conn.execute(
                        insert(departments).values(
                            tenant_id=scope.tenant_id,
                            code=payload.code,
                            name=payload.name,
                        )
                    )
                    created += 1
                    rows.append(
                        DepartmentImportRow(
                            row=idx,
                            code=payload.code,
                            name=payload.name,
                            status="created",
                        )
                    )
        except Exception as exc:  # noqa: BLE001
            errors += 1
            rows.append(
                DepartmentImportRow(
                    row=idx,
                    code=payload.code,
                    name=payload.name,
                    status="error",
                    error=type(exc).__name__,
                )
            )

    # Single audit row summarising the whole import.
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="department.imported",
            entity_type="department",
            entity_id="import",
            after={"created": created, "updated": updated, "errors": errors},
        )

    return DepartmentImportResult(
        created=created,
        updated=updated,
        errors=errors,
        rows=rows,
    )


def _count_employees(scope: TenantScope, department_id: int) -> int:
    engine = get_engine()
    with engine.begin() as conn:
        n = conn.execute(
            select(func.count())
            .select_from(employees)
            .where(
                employees.c.tenant_id == scope.tenant_id,
                employees.c.department_id == department_id,
                employees.c.status != "deleted",
            )
        ).scalar_one()
    return int(n or 0)


# ---------------------------------------------------------------------------
# Department-manager assignment (user_departments)
# ---------------------------------------------------------------------------
#
# A Manager added here lands in ``user_departments`` and immediately
# becomes visible-in-scope for every employee currently in (and every
# future employee added to) that department — the existing
# ``get_manager_visible_employee_ids`` helper unions
# ``user_departments`` with ``manager_assignments``, so the attendance
# router, scheduler, calendar, approvals inbox, and reports all
# inherit the visibility automatically.
#
# Symmetric with the manager-assignments page (per-employee), this
# surface gives the operator the per-department lever: "every nurse in
# OPS reports to Sara" instead of clicking 47 nurses one by one.


class DepartmentManagerOut(BaseModel):
    user_id: int
    full_name: str
    email: str


class DepartmentManagerListOut(BaseModel):
    items: list[DepartmentManagerOut]


class DepartmentManagerAddIn(BaseModel):
    user_id: int


def _ensure_department(conn, scope: TenantScope, department_id: int) -> str:
    """Resolve the department code or 404. Used in audit payloads so an
    auditor sees which department was touched without re-joining."""
    row = conn.execute(
        select(departments.c.code).where(
            departments.c.tenant_id == scope.tenant_id,
            departments.c.id == department_id,
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="department not found")
    return str(row.code)


@router.get(
    "/{department_id}/managers",
    response_model=DepartmentManagerListOut,
)
def list_department_managers(
    department_id: int, user: Annotated[CurrentUser, AUTH]
) -> DepartmentManagerListOut:
    """List the Manager-role users assigned to this department.

    Open to every authenticated role — the same permission stance as
    the parent department list. Mutation stays Admin/HR only.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        _ensure_department(conn, scope, department_id)
        rows = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email)
            .select_from(
                user_departments.join(
                    users,
                    (users.c.id == user_departments.c.user_id)
                    & (users.c.tenant_id == user_departments.c.tenant_id),
                )
            )
            .where(
                user_departments.c.tenant_id == scope.tenant_id,
                user_departments.c.department_id == department_id,
            )
            .order_by(users.c.full_name.asc())
        ).all()
    return DepartmentManagerListOut(
        items=[
            DepartmentManagerOut(
                user_id=int(r.id),
                full_name=str(r.full_name),
                email=str(r.email),
            )
            for r in rows
        ]
    )


@router.post(
    "/{department_id}/managers",
    response_model=DepartmentManagerOut,
    status_code=status.HTTP_201_CREATED,
)
def assign_department_manager(
    department_id: int,
    payload: DepartmentManagerAddIn,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> DepartmentManagerOut:
    """Assign a user (must hold the Manager role) to this department.

    Idempotent — re-assigning an already-assigned user returns the
    existing row instead of 409, so a double-click in the picker is
    harmless. The Manager-role check is enforced server-side; the
    UI's filtered dropdown is convenience only.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        dept_code = _ensure_department(conn, scope, department_id)
        target = conn.execute(
            select(users.c.id, users.c.full_name, users.c.email).where(
                users.c.tenant_id == scope.tenant_id,
                users.c.id == payload.user_id,
                users.c.is_active.is_(True),
            )
        ).first()
        if target is None:
            raise HTTPException(
                status_code=404, detail="user not found or inactive"
            )

        # Manager-role guard. We check via user_roles → roles join so a
        # user with multiple roles still passes as long as one of them
        # is Manager.
        has_manager = conn.execute(
            select(roles.c.code)
            .select_from(
                user_roles.join(roles, roles.c.id == user_roles.c.role_id)
            )
            .where(
                user_roles.c.tenant_id == scope.tenant_id,
                user_roles.c.user_id == payload.user_id,
                roles.c.code == "Manager",
            )
            .limit(1)
        ).first()
        if has_manager is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "field": "user_id",
                    "message": (
                        "user must hold the Manager role to be "
                        "assigned to a department"
                    ),
                },
            )

        # Idempotent insert — duplicate is a no-op.
        existing = conn.execute(
            select(user_departments.c.user_id).where(
                user_departments.c.tenant_id == scope.tenant_id,
                user_departments.c.user_id == payload.user_id,
                user_departments.c.department_id == department_id,
            )
        ).first()
        if existing is None:
            conn.execute(
                insert(user_departments).values(
                    tenant_id=scope.tenant_id,
                    user_id=payload.user_id,
                    department_id=department_id,
                )
            )
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="department.manager_assigned",
                entity_type="department",
                entity_id=str(department_id),
                after={
                    "department_code": dept_code,
                    "manager_user_id": payload.user_id,
                    "manager_email": str(target.email),
                },
            )
            logger.info(
                "department manager assigned: dept=%s user=%s by=%s",
                dept_code,
                payload.user_id,
                user.id,
            )
    return DepartmentManagerOut(
        user_id=int(target.id),
        full_name=str(target.full_name),
        email=str(target.email),
    )


@router.delete(
    "/{department_id}/managers/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_department_manager(
    department_id: int,
    user_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> None:
    """Remove a Manager from this department's roster.

    Idempotent — removing an already-absent user is a 204, not a 404,
    so the operator's "remove" button always succeeds.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()
    with engine.begin() as conn:
        dept_code = _ensure_department(conn, scope, department_id)
        result = conn.execute(
            sql_delete(user_departments).where(
                user_departments.c.tenant_id == scope.tenant_id,
                user_departments.c.user_id == user_id,
                user_departments.c.department_id == department_id,
            )
        )
        if result.rowcount > 0:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="department.manager_removed",
                entity_type="department",
                entity_id=str(department_id),
                after={
                    "department_code": dept_code,
                    "manager_user_id": user_id,
                },
            )
            logger.info(
                "department manager removed: dept=%s user=%s by=%s",
                dept_code,
                user_id,
                user.id,
            )
