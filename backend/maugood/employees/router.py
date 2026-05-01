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
from typing import Annotated, Literal, Optional

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

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import (
    CurrentUser,
    current_user,
    require_any_role,
    require_role,
)
from maugood.custom_fields import repository as cf_repo
from maugood.db import departments as dept_table, get_engine
from maugood.employees import excel as excel_io
from maugood.employees import pdpl as pdpl_module
from maugood.employees import photos as photos_io
from maugood.employees import repository as repo
from maugood.identification import enrollment as id_enrollment
from maugood.identification.matcher import matcher_cache
from maugood.employees.schemas import (
    EmployeeCreateIn,
    EmployeeListOut,
    EmployeeOut,
    EmployeePatchIn,
    ImportError as ImportErrorSchema,
    ImportPreviewResult,
    ImportPreviewRow,
    ImportResult,
    ImportWarning as ImportWarningSchema,
    PhotoIngestAccepted,
    PhotoIngestRejected,
    PhotoIngestResult,
    PhotoListOut,
    PhotoOut,
)
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Mirrors the departments_router code-shape regex. The Excel import
# auto-creates departments when an unknown code lands on a row; we
# reject codes that wouldn't pass the standalone create endpoint so
# the on-the-fly path can't sneak data through that the dedicated CRUD
# would reject.
import re as _re
_DEPT_CODE_RE = _re.compile(r"^[A-Z0-9_]{1,16}$")


def _slugify_to_code(name: str, max_len: int = 16) -> str:
    """Generate a deterministic short code from a free-form name.

    Examples::

        "Operations Unit" -> "OPERATIONS_UNIT"
        "Branding and Communications" -> "BRANDING_AND_COM"
        "Information and Communication Technology" -> "IACT"

    The result is uppercase ASCII, restricted to ``[A-Z0-9_]``, and never
    longer than ``max_len`` (16 by default — matches ``_DEPT_CODE_RE``).
    Returns an empty string when ``name`` carries no usable characters;
    the caller falls back to a generic prefix in that case.
    """

    squashed = _re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper()
    if not squashed:
        return ""
    if len(squashed) <= max_len:
        return squashed
    # Too long: try an acronym from the original word boundaries.
    words = [w for w in _re.split(r"[^A-Za-z0-9]+", name) if w]
    acronym = "".join(w[0].upper() for w in words)
    if 2 <= len(acronym) <= max_len:
        return acronym
    return squashed[:max_len].rstrip("_") or squashed[:max_len]


def _resolve_or_create_code(
    conn: Connection,
    *,
    table,
    tenant_id: int,
    raw_value: str,
    parent_department_id: Optional[int] = None,
) -> tuple[int, str, str, bool]:
    """Look up or auto-create a (code, name) row from a free-form import value.

    Behaviour:
      * If ``raw_value`` already matches ``_DEPT_CODE_RE`` (i.e. looks
        like an existing short code), prefer matching by code first.
      * Otherwise look up by **name** (case-insensitive) — operators
        often paste the same display name twice; reuse the existing
        row regardless of how its code was generated last time.
      * On miss, generate a unique short code via ``_slugify_to_code``;
        if the generated code collides with another row, append
        ``_2``, ``_3``, … until free.

    Returns ``(row_id, resolved_code, resolved_name, created)``.
    The caller writes the audit row + warning when ``created`` is True.

    ``parent_department_id`` is set when resolving a section row, since
    sections are unique per department rather than per tenant.
    """

    from sqlalchemy import insert as _insert  # noqa: PLC0415
    from sqlalchemy import select as _select  # noqa: PLC0415

    value = raw_value.strip()
    base_filters = [table.c.tenant_id == tenant_id]
    if parent_department_id is not None:
        base_filters.append(table.c.department_id == parent_department_id)

    if _DEPT_CODE_RE.match(value.upper()):
        existing = conn.execute(
            _select(table.c.id, table.c.code, table.c.name).where(
                *base_filters, table.c.code == value.upper()
            )
        ).first()
        if existing is not None:
            return int(existing.id), str(existing.code), str(existing.name), False

    name_lookup = conn.execute(
        _select(table.c.id, table.c.code, table.c.name).where(
            *base_filters, func.lower(table.c.name) == value.lower()
        )
    ).first()
    if name_lookup is not None:
        return int(name_lookup.id), str(name_lookup.code), str(name_lookup.name), False

    base_code = _slugify_to_code(value) or "ITEM"
    candidate = base_code
    suffix = 2
    while True:
        clash = conn.execute(
            _select(table.c.id).where(*base_filters, table.c.code == candidate)
        ).first()
        if clash is None:
            break
        tail = f"_{suffix}"
        trimmed = base_code[: max(1, 16 - len(tail))]
        candidate = f"{trimmed}{tail}"
        suffix += 1

    insert_values: dict[str, object] = {
        "tenant_id": tenant_id,
        "code": candidate,
        "name": value,
    }
    if parent_department_id is not None:
        insert_values["department_id"] = parent_department_id

    new_id = conn.execute(
        _insert(table).values(**insert_values).returning(table.c.id)
    ).scalar_one()
    return int(new_id), candidate, value, True


def _maybe_create_default_employee_login(
    *,
    conn: Connection,
    scope: TenantScope,
    actor_user_id: int,
    employee_email: str,
    employee_full_name: str,
    warnings: list,
    excel_row: int,
) -> None:
    """Create a default platform login for an imported employee.

    No-op when a user already exists for the email (case-insensitive)
    in this tenant; emits a warning so the operator can see the skip.
    Otherwise inserts the ``users`` + ``user_roles`` rows linking the
    new account to the tenant's ``Employee`` role.

    Random 24-char URL-safe token as the temp password — never
    surfaced in the response or logs. Operators reset per-employee
    from the Edit drawer for whoever actually needs to sign in.
    """

    import secrets  # noqa: PLC0415
    from sqlalchemy import insert as _insert  # noqa: PLC0415
    from sqlalchemy import select as _select  # noqa: PLC0415

    from maugood.auth.passwords import hash_password  # noqa: PLC0415
    from maugood.db import roles as _roles  # noqa: PLC0415
    from maugood.db import user_roles as _user_roles  # noqa: PLC0415
    from maugood.db import users as _users  # noqa: PLC0415

    email_lower = employee_email.strip().lower()

    existing = conn.execute(
        _select(_users.c.id).where(
            _users.c.tenant_id == scope.tenant_id,
            func.lower(_users.c.email) == email_lower,
        )
    ).first()
    if existing is not None:
        warnings.append(
            ImportWarningSchema(
                row=excel_row,
                message=(
                    f"login already exists for {email_lower} — "
                    "kept the existing account, no roles changed"
                ),
            )
        )
        return

    role_row = conn.execute(
        _select(_roles.c.id).where(
            _roles.c.tenant_id == scope.tenant_id,
            _roles.c.code == "Employee",
        )
    ).first()
    if role_row is None:
        # Fail loud rather than silent: the per-tenant seed always
        # plants the four roles. Missing Employee role is a system
        # config bug, not an operator-fixable per-row issue.
        raise RuntimeError(
            "Employee role missing for tenant — provisioning is broken"
        )

    password_hash = hash_password(secrets.token_urlsafe(24))
    new_user_id = conn.execute(
        _insert(_users)
        .values(
            tenant_id=scope.tenant_id,
            email=email_lower,
            password_hash=password_hash,
            full_name=employee_full_name.strip(),
            is_active=True,
        )
        .returning(_users.c.id)
    ).scalar_one()

    conn.execute(
        _insert(_user_roles).values(
            tenant_id=scope.tenant_id,
            user_id=int(new_user_id),
            role_id=int(role_row.id),
        )
    )

    write_audit(
        conn,
        tenant_id=scope.tenant_id,
        actor_user_id=actor_user_id,
        action="user.created",
        entity_type="user",
        entity_id=str(new_user_id),
        after={
            "email": email_lower,
            "full_name": employee_full_name.strip(),
            "role_codes": ["Employee"],
            "source": "import",
        },
    )


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
        division=(
            {
                "id": row.division_id,
                "code": row.division_code or "",
                "name": row.division_name or "",
            }
            if row.division_id is not None
            else None
        ),
        section=(
            {
                "id": row.section_id,
                "code": row.section_code or "",
                "name": row.section_name or "",
            }
            if row.section_id is not None
            else None
        ),
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
        role_codes=list(row.role_codes),
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
    sort_by: Annotated[
        Literal["employee_code", "full_name", "department"],
        Query(description="Sort key (employee_code | full_name | department)."),
    ] = "employee_code",
    sort_dir: Annotated[
        Literal["asc", "desc"], Query(description="Sort direction.")
    ] = "asc",
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
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
    return EmployeeListOut(
        items=[_row_to_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/export")
def export_employees_endpoint(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    ids: Annotated[Optional[str], Query()] = None,
) -> StreamingResponse:
    """Full-tenant XLSX dump (active + inactive), one sheet named
    Employees. ``?ids=1,2,3`` scopes the export to the listed
    employee ids — used by the list page's "Export selected" path.
    Unknown ids in the list are silently dropped."""

    scope = TenantScope(tenant_id=user.tenant_id)
    selected_ids: Optional[set[int]] = None
    if ids:
        try:
            selected_ids = {
                int(part) for part in ids.split(",") if part.strip()
            }
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="``ids`` must be a comma-separated list of integers",
            )
    with get_engine().begin() as conn:
        rows = repo.list_all_for_export(conn, scope)
        if selected_ids is not None:
            rows = [r for r in rows if r.id in selected_ids]
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
            from maugood.db import users as _users  # noqa: PLC0415

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

        # Validate section_id (when set) belongs to the resolved
        # department + this tenant. Guards against cross-tenant /
        # cross-dept smuggling via the wire — and surfaces a clean
        # 400 when the operator picked a section under a different
        # department.
        if payload.section_id is not None:
            from sqlalchemy import select as _select  # noqa: PLC0415
            from maugood.db import sections as _sections  # noqa: PLC0415

            sec_row = conn.execute(
                _select(_sections.c.id).where(
                    _sections.c.tenant_id == scope.tenant_id,
                    _sections.c.id == payload.section_id,
                    _sections.c.department_id == dept_id,
                )
            ).first()
            if sec_row is None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "section_id is not a section under the resolved "
                        "department"
                    ),
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
            section_id=payload.section_id,
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


@router.get("/me", response_model=EmployeeOut)
def get_my_employee_endpoint(
    user: Annotated[CurrentUser, Depends(current_user)],
) -> EmployeeOut:
    """Return the employee record linked to the logged-in user.

    Mapping is by lower-cased email (the same shortcut the frontend
    "self-view" pages have been using inline). Open to every
    authenticated role — Employees + Managers + HR + Admin all need
    to see "themselves" on /my-attendance and /calendar without
    pulling the entire employees list. 404 if no row matches.

    Declared before ``/{employee_id}`` so FastAPI's static-path
    matching wins over the dynamic int parameter.
    """

    if not user.email:
        raise HTTPException(
            status_code=404, detail="no employee linked to this account"
        )
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        row = repo.get_employee_by_email(conn, scope, user.email)
    if row is None:
        raise HTTPException(
            status_code=404, detail="no employee linked to this account"
        )
    return _row_to_out(row)


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

        # P29 (#3) — section assignment. Validate it sits under the
        # department being applied (either freshly resolved above or
        # the existing one). The wire is opt-in: ``section_id=None``
        # with the field ``in provided`` clears the assignment;
        # field omitted entirely leaves it as-is.
        if "section_id" in provided:
            new_sec = provided["section_id"]
            if new_sec is None:
                values["section_id"] = None
            else:
                from sqlalchemy import select as _select  # noqa: PLC0415
                from maugood.db import sections as _sections  # noqa: PLC0415

                effective_dept_id = values.get(
                    "department_id", before.department_id
                )
                sec_row = conn.execute(
                    _select(_sections.c.id).where(
                        _sections.c.tenant_id == scope.tenant_id,
                        _sections.c.id == int(new_sec),
                        _sections.c.department_id == effective_dept_id,
                    )
                ).first()
                if sec_row is None:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "section_id is not a section under the "
                            "resolved department"
                        ),
                    )
                values["section_id"] = int(new_sec)

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


from pydantic import BaseModel as _TM_BaseModel  # noqa: E402


class TeamMemberOut(_TM_BaseModel):
    id: int
    employee_code: str
    full_name: str
    designation: Optional[str] = None
    # Dev-visibility: each member's resolved org tiers so the operator
    # can eyeball which rule fired for which row. ``None`` when the
    # employee isn't mapped at that tier (sections are optional, and
    # divisions are derived through ``departments.division_id``).
    division_name: Optional[str] = None
    department_name: Optional[str] = None
    section_name: Optional[str] = None


class TeamMembersOut(_TM_BaseModel):
    # ``scope`` describes which tier of the org structure the team
    # was resolved against, so the frontend can label the tab
    # accurately ("Division · Engineering" / "Department · Ops").
    scope: Literal["division", "department"]
    scope_name: str
    items: list[TeamMemberOut]


@router.get("/{employee_id}/team-members", response_model=TeamMembersOut)
def list_team_members_endpoint(
    employee_id: int,
    user: Annotated[
        CurrentUser, Depends(require_any_role("Admin", "HR", "Manager"))
    ],
) -> TeamMembersOut:
    """Resolve an employee's team-mates by an org-structure rule set.

    * Rule 1 — when ``division.name == department.name == section.name``
      (all three exist with the same name): team is every active
      employee whose department rolls up to the same division.
    * Otherwise (Rule 2 or fall-back): team is every active employee
      in the same department.

    Comparison is on the ``name`` column per the product spec.
    Self-excluded; ``status='active'`` only.

    Manager scope: a Manager can fetch this for any employee in
    their visible set (department membership ∪ direct
    ``manager_assignments`` per P8); out-of-scope ids return 404 to
    avoid leaking existence. Admin/HR see any employee.
    """

    from sqlalchemy import select as _select  # noqa: PLC0415

    from maugood.db import (  # noqa: PLC0415
        departments as _departments,
        divisions as _divisions,
        employees as _employees,
        sections as _sections,
    )
    from maugood.manager_assignments.repository import (  # noqa: PLC0415
        get_manager_visible_employee_ids,
    )

    scope = TenantScope(tenant_id=user.tenant_id)
    is_admin_or_hr = "Admin" in user.roles or "HR" in user.roles

    with get_engine().begin() as conn:
        target = conn.execute(
            _select(
                _employees.c.id,
                _employees.c.department_id,
                _employees.c.section_id,
                _departments.c.name.label("dept_name"),
                _departments.c.division_id,
                _divisions.c.name.label("div_name"),
                _sections.c.name.label("sec_name"),
            )
            .select_from(
                _employees.join(
                    _departments,
                    (_departments.c.id == _employees.c.department_id)
                    & (_departments.c.tenant_id == _employees.c.tenant_id),
                )
                .outerjoin(
                    _divisions,
                    (_divisions.c.id == _departments.c.division_id)
                    & (_divisions.c.tenant_id == _employees.c.tenant_id),
                )
                .outerjoin(
                    _sections,
                    (_sections.c.id == _employees.c.section_id)
                    & (_sections.c.tenant_id == _employees.c.tenant_id),
                )
            )
            .where(
                _employees.c.tenant_id == scope.tenant_id,
                _employees.c.id == employee_id,
            )
        ).first()
        if target is None:
            raise HTTPException(status_code=404, detail="employee not found")

        if not is_admin_or_hr:
            visible = get_manager_visible_employee_ids(
                conn, scope, manager_user_id=user.id
            )
            if employee_id not in visible:
                # 404 not 403 — never leak existence to a Manager who
                # can't see the row.
                raise HTTPException(status_code=404, detail="employee not found")

        div_name = target.div_name
        dept_name = target.dept_name
        sec_name = target.sec_name

        rule_one = (
            div_name is not None
            and dept_name is not None
            and sec_name is not None
            and div_name == dept_name == sec_name
            and target.division_id is not None
        )

        base = (
            _select(
                _employees.c.id,
                _employees.c.employee_code,
                _employees.c.full_name,
                _employees.c.designation,
                _divisions.c.name.label("member_div_name"),
                _departments.c.name.label("member_dept_name"),
                _sections.c.name.label("member_sec_name"),
            )
            .select_from(
                _employees.join(
                    _departments,
                    (_departments.c.id == _employees.c.department_id)
                    & (_departments.c.tenant_id == _employees.c.tenant_id),
                )
                .outerjoin(
                    _divisions,
                    (_divisions.c.id == _departments.c.division_id)
                    & (_divisions.c.tenant_id == _employees.c.tenant_id),
                )
                .outerjoin(
                    _sections,
                    (_sections.c.id == _employees.c.section_id)
                    & (_sections.c.tenant_id == _employees.c.tenant_id),
                )
            )
            .where(
                _employees.c.tenant_id == scope.tenant_id,
                _employees.c.id != employee_id,
                _employees.c.status == "active",
            )
            .order_by(_employees.c.full_name.asc())
        )

        if rule_one:
            stmt = base.where(_departments.c.division_id == target.division_id)
            scope_label: Literal["division", "department"] = "division"
            scope_name = div_name or ""
        else:
            stmt = base.where(_employees.c.department_id == target.department_id)
            scope_label = "department"
            scope_name = dept_name or ""

        rows = conn.execute(stmt).all()

    return TeamMembersOut(
        scope=scope_label,
        scope_name=scope_name,
        items=[
            TeamMemberOut(
                id=int(r.id),
                employee_code=str(r.employee_code),
                full_name=str(r.full_name),
                designation=(
                    str(r.designation) if r.designation is not None else None
                ),
                division_name=(
                    str(r.member_div_name)
                    if r.member_div_name is not None
                    else None
                ),
                department_name=(
                    str(r.member_dept_name)
                    if r.member_dept_name is not None
                    else None
                ),
                section_name=(
                    str(r.member_sec_name)
                    if r.member_sec_name is not None
                    else None
                ),
            )
            for r in rows
        ],
    )


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
    ``deleted-{id}@maugood.local``, and flips ``status='deleted'``.
    Attendance, audit, and request rows stay (verifiable history
    per BRD NFR-RET-004).

    The confirmation phrase is the brake — a sloppy curl can't
    accidentally invoke this endpoint. The phrase is exposed
    via ``maugood.employees.pdpl.PDPL_CONFIRMATION_PHRASE`` for
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


# ---- Bulk delete -----------------------------------------------------
#
# Two scopes — explicit ``ids=[…]`` for the "delete selected" UX, or
# ``scope="all"`` to wipe every active+inactive employee in the tenant.
# Two modes — ``mode="soft"`` (status='inactive', reversible) or
# ``mode="hard"`` (PDPL erasure, irreversible — drops photos,
# custom-field values, redacts PII, audits). Hard mode reuses the
# single-row PDPL helper so the audit shape stays identical to
# ``POST /api/employees/{id}/gdpr-delete``.
#
# Hard mode requires the PDPL confirmation phrase. Soft mode does
# not — soft delete is reversible by editing the row.


class BulkDeleteRequest(BaseModel):
    scope: Literal["selected", "all"] = _PydField(
        ..., description="``selected`` requires ``ids``; ``all`` ignores it."
    )
    mode: Literal["soft", "hard"] = _PydField(
        ...,
        description=(
            "``soft`` flips status to inactive (reversible). ``hard`` "
            "is PDPL erasure (irreversible) and requires "
            "``confirmation``."
        ),
    )
    ids: Optional[list[int]] = _PydField(
        default=None,
        description="Required when ``scope='selected'``; ignored otherwise.",
    )
    confirmation: Optional[str] = _PydField(
        default=None,
        max_length=64,
        description=(
            "Required when ``mode='hard'``. Must equal "
            f"{pdpl_module.PDPL_CONFIRMATION_PHRASE!r}."
        ),
    )


class BulkDeleteResponse(BaseModel):
    scope: Literal["selected", "all"]
    mode: Literal["soft", "hard"]
    requested: int
    deleted: int
    skipped: int
    errors: list[ImportErrorSchema] = []


@router.post("/bulk-delete", response_model=BulkDeleteResponse)
def bulk_delete_endpoint(
    payload: BulkDeleteRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> BulkDeleteResponse:
    """Soft- or hard-delete multiple employees in one call.

    Admin-only. Selected scope drives the row set off the request body's
    ``ids``; ``all`` scope walks every employee in the tenant.

    Hard delete reuses ``pdpl_delete_employee`` per row inside its own
    transaction so a single failure (file-system permission, etc.)
    doesn't abort the rest of the batch — the per-row errors come back
    in ``errors``.
    """

    if payload.mode == "hard":
        if payload.confirmation != pdpl_module.PDPL_CONFIRMATION_PHRASE:
            raise HTTPException(
                status_code=400,
                detail=(
                    "confirmation phrase did not match (case + whitespace "
                    "sensitive)"
                ),
            )

    if payload.scope == "selected":
        if not payload.ids:
            raise HTTPException(
                status_code=400, detail="ids[] is required when scope='selected'"
            )
        target_ids = list(dict.fromkeys(payload.ids))  # de-dup, keep order
    else:
        target_ids = []

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    if payload.scope == "all":
        with engine.begin() as conn:
            from sqlalchemy import select as _select  # noqa: PLC0415
            from maugood.db import employees as _employees  # noqa: PLC0415

            target_ids = [
                int(r.id)
                for r in conn.execute(
                    _select(_employees.c.id).where(
                        _employees.c.tenant_id == scope.tenant_id,
                        _employees.c.status != "deleted",
                    )
                ).fetchall()
            ]

    deleted = 0
    skipped = 0
    errors: list[ImportErrorSchema] = []

    for emp_id in target_ids:
        try:
            with engine.begin() as conn:
                existing = repo.get_employee(conn, scope, emp_id)
                if existing is None:
                    skipped += 1
                    continue
                if payload.mode == "soft":
                    if existing.status == "inactive":
                        skipped += 1
                        continue
                    repo.soft_delete_employee(conn, scope, emp_id)
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="employee.soft_deleted",
                        entity_type="employee",
                        entity_id=str(emp_id),
                        before={"status": existing.status},
                        after={
                            "status": "inactive",
                            "employee_code": existing.employee_code,
                            "source": "bulk",
                        },
                    )
                    deleted += 1
                else:
                    # Bulk hard mode = full purge. Drops the row +
                    # every cascading reference. The single-row PDPL
                    # endpoint (``/gdpr-delete``) still uses the
                    # redact-then-keep flow for compliance.
                    pdpl_module.purge_employee(
                        conn,
                        scope,
                        employee_id=emp_id,
                        actor_user_id=user.id,
                    )
                    deleted += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "bulk-delete failed for employee %d: %s",
                emp_id,
                exc,
                exc_info=True,
            )
            errors.append(
                ImportErrorSchema(
                    row=emp_id,
                    message=str(exc).split("\n", 1)[0].strip()
                    or exc.__class__.__name__,
                )
            )

    # Summary audit row so an operator can search the audit log for
    # one entry rather than N — the per-row writes above are still
    # the verifiable record.
    with engine.begin() as conn:
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="employee.bulk_deleted",
            entity_type="employee",
            after={
                "scope": payload.scope,
                "mode": payload.mode,
                "requested": len(target_ids),
                "deleted": deleted,
                "skipped": skipped,
                "error_count": len(errors),
            },
        )

    return BulkDeleteResponse(
        scope=payload.scope,
        mode=payload.mode,
        requested=len(target_ids),
        deleted=deleted,
        skipped=skipped,
        errors=errors,
    )


@router.post("/import-preview", response_model=ImportPreviewResult)
async def import_preview_endpoint(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    file: UploadFile = File(...),
) -> ImportPreviewResult:
    """Dry-run an employee import: parse the file, apply defaults, return
    the rows and per-row errors **without writing anything**.

    The frontend posts the same file twice — once here for the
    preview, then to ``POST /api/employees/import`` after the
    operator confirms. The duplication is intentional: keeping the
    actual import endpoint stateless avoids the question of "what
    happened to my upload between page reloads".
    """

    data = await file.read()
    is_csv = (file.filename or "").lower().endswith(".csv")
    try:
        if is_csv:
            rows = list(excel_io.parse_csv_import(data))
        else:
            rows = list(excel_io.parse_import(BytesIO(data)))
    except excel_io.ImportParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    scope = TenantScope(tenant_id=user.tenant_id)
    engine = get_engine()

    # Probe existing employee codes in one shot so the preview can
    # flag duplicates in the same UI pass instead of waiting for the
    # actual import to fail per row.
    candidate_codes = [r.employee_code for r in rows if r.employee_code]
    existing_codes: set[str] = set()
    if candidate_codes:
        from sqlalchemy import select as _select  # noqa: PLC0415
        from maugood.db import employees as _employees  # noqa: PLC0415

        with engine.begin() as conn:
            existing_codes = {
                str(row.employee_code)
                for row in conn.execute(
                    _select(_employees.c.employee_code).where(
                        _employees.c.tenant_id == scope.tenant_id,
                        _employees.c.employee_code.in_(candidate_codes),
                    )
                ).fetchall()
            }

    preview_rows: list[ImportPreviewRow] = []
    errors: list[ImportErrorSchema] = []
    today_iso = datetime.now(tz=timezone.utc).date().isoformat()
    seen: set[str] = set()

    for r in rows:
        if not r.employee_code:
            errors.append(
                ImportErrorSchema(row=r.excel_row, message="employee_code is required")
            )
            continue
        if not r.full_name:
            errors.append(
                ImportErrorSchema(row=r.excel_row, message="full_name is required")
            )
            continue
        if not r.department_code:
            errors.append(
                ImportErrorSchema(
                    row=r.excel_row, message="department_code is required"
                )
            )
            continue
        if r.employee_code in seen:
            errors.append(
                ImportErrorSchema(
                    row=r.excel_row,
                    message=(
                        f"duplicate employee_code '{r.employee_code}' "
                        "earlier in file"
                    ),
                )
            )
            continue
        if r.employee_code in existing_codes:
            errors.append(
                ImportErrorSchema(
                    row=r.excel_row,
                    message=(
                        f"employee_code '{r.employee_code}' already exists"
                    ),
                )
            )
            continue
        seen.add(r.employee_code)

        # Mirror the import handler's joining_date fallback so the
        # preview shows the operator exactly what will land in the DB.
        joining = r.joining_date
        defaulted = False
        if not joining or not joining.strip():
            joining = today_iso
            defaulted = True

        preview_rows.append(
            ImportPreviewRow(
                row=r.excel_row,
                employee_code=r.employee_code,
                full_name=r.full_name,
                email=r.email,
                designation=r.designation,
                phone=r.phone,
                division=r.division_code,
                department=r.department_code,
                section=r.section_code,
                joining_date=joining,
                relieving_date=r.relieving_date,
                reports_to_email=r.reports_to_email,
                defaulted_joining_date=defaulted,
            )
        )

    return ImportPreviewResult(rows=preview_rows, errors=errors, warnings=[])


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

    # Auto-detect CSV vs XLSX by filename — XLSX is the historical
    # default; CSV was added so operators can edit in any text editor.
    is_csv = (file.filename or "").lower().endswith(".csv")
    try:
        if is_csv:
            rows = list(excel_io.parse_csv_import(data))
        else:
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
        # anything else. A missing ``joining_date`` defaults to today
        # in the tenant's timezone — the operator usually imports the
        # roster on the day a hire starts and forgets the column;
        # the lifecycle cron then ignores them rather than treating
        # the row as a "future joiner" with a NULL date.
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
        if joining is None:
            from datetime import date as _date_today  # noqa: PLC0415

            joining = _date_today.today()
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
                dept_id, dept_code, dept_name, dept_created = _resolve_or_create_code(
                    conn,
                    table=dept_table,
                    tenant_id=scope.tenant_id,
                    raw_value=row.department_code,
                )
                if dept_created:
                    write_audit(
                        conn,
                        tenant_id=scope.tenant_id,
                        actor_user_id=user.id,
                        action="department.created",
                        entity_type="department",
                        entity_id=str(dept_id),
                        after={
                            "code": dept_code,
                            "name": dept_name,
                            "auto_imported_for": row.employee_code,
                        },
                    )
                    warnings.append(
                        ImportWarningSchema(
                            row=row.excel_row,
                            message=(
                                f"created department '{dept_name}' "
                                f"(code {dept_code}) on the fly — "
                                "edit it from Settings → Departments"
                            ),
                        )
                    )
                dept = repo.get_department_by_id(conn, scope, dept_id)
                if dept is None:
                    raise _RowError(
                        f"failed to read back department '{dept_code}'"
                    )

                # P29 (#3) — division. Optional column. If the row
                # carries a division_code we resolve or auto-create
                # it, then make sure the resolved department is
                # linked to that division (UPDATE only when the FK
                # is currently null OR mismatches the imported value;
                # silently confirm when already correct so the
                # import is idempotent).
                from maugood.db import (  # noqa: PLC0415
                    divisions as _divisions,
                    sections as _sections,
                )

                if row.division_code:
                    div_id, div_code, div_name, div_created = _resolve_or_create_code(
                        conn,
                        table=_divisions,
                        tenant_id=scope.tenant_id,
                        raw_value=row.division_code,
                    )
                    if div_created:
                        write_audit(
                            conn,
                            tenant_id=scope.tenant_id,
                            actor_user_id=user.id,
                            action="division.created",
                            entity_type="division",
                            entity_id=str(div_id),
                            after={
                                "code": div_code,
                                "name": div_name,
                                "auto_imported_for": row.employee_code,
                            },
                        )
                        warnings.append(
                            ImportWarningSchema(
                                row=row.excel_row,
                                message=(
                                    f"created division '{div_name}' "
                                    f"(code {div_code}) on the fly — "
                                    "edit it from Settings → Divisions"
                                ),
                            )
                        )
                    if dept.division_id != div_id:
                        conn.execute(
                            dept_table.update()
                            .where(
                                dept_table.c.tenant_id == scope.tenant_id,
                                dept_table.c.id == dept.id,
                            )
                            .values(division_id=div_id)
                        )

                # P29 (#3) — section. Optional. Sections are scoped
                # per department; the same code can re-appear under
                # different parents. Auto-create when missing under
                # the resolved department.
                section_id_for_employee: Optional[int] = None
                if row.section_code:
                    sec_id, sec_code, sec_name, sec_created = _resolve_or_create_code(
                        conn,
                        table=_sections,
                        tenant_id=scope.tenant_id,
                        raw_value=row.section_code,
                        parent_department_id=dept.id,
                    )
                    if sec_created:
                        write_audit(
                            conn,
                            tenant_id=scope.tenant_id,
                            actor_user_id=user.id,
                            action="section.created",
                            entity_type="section",
                            entity_id=str(sec_id),
                            after={
                                "code": sec_code,
                                "name": sec_name,
                                "department_id": dept.id,
                                "department_code": dept_code,
                                "auto_imported_for": row.employee_code,
                            },
                        )
                        warnings.append(
                            ImportWarningSchema(
                                row=row.excel_row,
                                message=(
                                    f"created section '{sec_name}' "
                                    f"(code {dept_code}/{sec_code}) on the "
                                    "fly — edit it from Settings → Sections"
                                ),
                            )
                        )
                    section_id_for_employee = sec_id

                # P28.7: resolve reports_to_email → user_id within the
                # tenant. Unknown email is a per-row error so the
                # operator can fix the spelling without losing the rest
                # of the file.
                reports_to_id: Optional[int] = None
                if row.reports_to_email:
                    from sqlalchemy import select as _select  # noqa: PLC0415
                    from maugood.db import users as _users  # noqa: PLC0415

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
                if existing is not None:
                    # Strict create-only import: a duplicate
                    # ``employee_code`` is a per-row error so the
                    # operator can fix the file and re-upload. The
                    # existing row stays untouched.
                    raise _RowError(
                        f"employee_code '{row.employee_code}' already exists"
                    )

                new_id = repo.create_employee(
                    conn,
                    scope,
                    employee_code=row.employee_code,
                    full_name=row.full_name,
                    email=row.email,
                    department_id=dept.id,
                    section_id=section_id_for_employee,
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

                # Default platform login: every imported employee
                # gets a ``users`` row + Employee role so the role is
                # surfaced on the employees list immediately. Future
                # role changes go through the Edit drawer.
                #
                # When the import row has an email, that's the login
                # email. When it doesn't (HR rosters often skip
                # email), we synthesise one from the employee_code
                # so the row is unique and the operator can either
                # leave it placeholder or override later. The
                # synthesised local-suffix `.maugood.local` is the
                # same convention the PDPL redact path uses, so a
                # quick grep tells you "no real email".
                login_email = (
                    row.email.strip()
                    if row.email and row.email.strip()
                    else f"{row.employee_code.lower()}@maugood.local"
                )
                _maybe_create_default_employee_login(
                    conn=conn,
                    scope=scope,
                    actor_user_id=user.id,
                    employee_email=login_email,
                    employee_full_name=row.full_name,
                    warnings=warnings,
                    excel_row=row.excel_row,
                )
                # Backfill the employee row's email when we
                # synthesised one — keeps the user↔employee join
                # working in the list view (which matches by email).
                if not row.email:
                    repo.update_employee(
                        conn,
                        scope,
                        new_id,
                        values={"email": login_email},
                    )

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
            # RTSP URL) can't surface here because we never pass them
            # through the import path.
            logger.warning(
                "import row %d failed: %s", row.excel_row, exc, exc_info=True
            )
            # Surface the exception type + first line of message so an
            # operator hitting a regression sees enough detail to file a
            # report. The DB-side messages are operator-readable
            # (``permission denied for table X``, ``violates foreign
            # key constraint``, etc.).
            short = str(exc).split("\n", 1)[0].strip() or exc.__class__.__name__
            errors.append(
                ImportErrorSchema(
                    row=row.excel_row,
                    message=f"could not save row: {short}",
                )
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
