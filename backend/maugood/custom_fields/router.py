"""FastAPI router for ``/api/custom-fields`` and the per-employee
custom-field-values surface.

Field definition CRUD is Admin-only (it changes the schema operators
see for every employee). Value reads/writes are Admin + HR — same
authority as the rest of the employees API.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role, require_role
from maugood.custom_fields import repository as cf_repo
from maugood.custom_fields.schemas import (
    CustomFieldCreateRequest,
    CustomFieldPatchRequest,
    CustomFieldResponse,
    CustomFieldValueOut,
    EmployeeCustomFieldValuesPatch,
    ReorderRequest,
)
from maugood.db import get_engine
from maugood.employees import repository as emp_repo
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(tags=["custom-fields"])
ADMIN = Depends(require_role("Admin"))
ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))


def _to_response(row: cf_repo.FieldRow) -> CustomFieldResponse:
    return CustomFieldResponse(
        id=row.id,
        tenant_id=row.tenant_id,
        name=row.name,
        code=row.code,
        type=row.type,  # type: ignore[arg-type]
        options=row.options,
        required=row.required,
        display_order=row.display_order,
    )


# ---------------------------------------------------------------------------
# Field definitions
# ---------------------------------------------------------------------------


@router.get("/api/custom-fields", response_model=list[CustomFieldResponse])
def list_custom_fields(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> list[CustomFieldResponse]:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = cf_repo.list_fields(conn, scope)
    return [_to_response(r) for r in rows]


@router.post(
    "/api/custom-fields",
    response_model=CustomFieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_custom_field(
    payload: CustomFieldCreateRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> CustomFieldResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        if cf_repo.get_field_by_code(conn, scope, payload.code) is not None:
            raise HTTPException(
                status_code=409,
                detail=f"custom field with code {payload.code!r} already exists",
            )
        order = cf_repo.next_display_order(conn, scope)
        new_id = cf_repo.create_field(
            conn,
            scope,
            name=payload.name,
            code=payload.code,
            type=payload.type,
            options=payload.options,
            required=payload.required,
            display_order=order,
        )
        created = cf_repo.get_field(conn, scope, new_id)
        assert created is not None
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="custom_field.created",
            entity_type="custom_field",
            entity_id=str(new_id),
            after={
                "name": created.name,
                "code": created.code,
                "type": created.type,
                "required": created.required,
                "options": created.options,
                "display_order": created.display_order,
            },
        )
    return _to_response(created)


@router.patch(
    "/api/custom-fields/{field_id}", response_model=CustomFieldResponse
)
def patch_custom_field(
    field_id: int,
    payload: CustomFieldPatchRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> CustomFieldResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    provided = payload.model_dump(exclude_unset=True)

    with get_engine().begin() as conn:
        before = cf_repo.get_field(conn, scope, field_id)
        if before is None:
            raise HTTPException(status_code=404, detail="custom field not found")

        values: dict[str, object] = {}
        if "name" in provided:
            values["name"] = provided["name"]
        if "required" in provided:
            values["required"] = provided["required"]
        if "display_order" in provided:
            values["display_order"] = provided["display_order"]
        if "options" in provided:
            if before.type != "select":
                raise HTTPException(
                    status_code=400,
                    detail="options can only be set on select fields",
                )
            values["options"] = provided["options"]

        cf_repo.update_field(conn, scope, field_id, values=values)
        after = cf_repo.get_field(conn, scope, field_id)
        assert after is not None

        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="custom_field.updated",
            entity_type="custom_field",
            entity_id=str(field_id),
            before={
                "name": before.name,
                "required": before.required,
                "options": before.options,
                "display_order": before.display_order,
            },
            after={
                "name": after.name,
                "required": after.required,
                "options": after.options,
                "display_order": after.display_order,
            },
        )
    return _to_response(after)


@router.delete(
    "/api/custom-fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_custom_field(
    field_id: int,
    user: Annotated[CurrentUser, ADMIN],
    response: Response,
) -> Response:
    """Hard delete. ON DELETE CASCADE drops every employee value too."""

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        existing = cf_repo.get_field(conn, scope, field_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="custom field not found")
        cf_repo.delete_field(conn, scope, field_id)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="custom_field.deleted",
            entity_type="custom_field",
            entity_id=str(field_id),
            before={
                "name": existing.name,
                "code": existing.code,
                "type": existing.type,
            },
        )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/api/custom-fields/reorder", response_model=list[CustomFieldResponse])
def reorder_custom_fields(
    payload: ReorderRequest,
    user: Annotated[CurrentUser, ADMIN],
) -> list[CustomFieldResponse]:
    """Apply a new display order. Items not listed keep their current order."""

    scope = TenantScope(tenant_id=user.tenant_id)
    items = [(item.id, item.display_order) for item in payload.items]

    with get_engine().begin() as conn:
        # Validate every id belongs to this tenant before mutating.
        existing_ids = {r.id for r in cf_repo.list_fields(conn, scope)}
        for fid, _ in items:
            if fid not in existing_ids:
                raise HTTPException(
                    status_code=404,
                    detail=f"custom field {fid} not found",
                )
        cf_repo.reorder_fields(conn, scope, items=items)
        after = cf_repo.list_fields(conn, scope)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="custom_field.reordered",
            entity_type="custom_field",
            after={"items": [{"id": fid, "display_order": o} for fid, o in items]},
        )
    return [_to_response(r) for r in after]


# ---------------------------------------------------------------------------
# Per-employee values
# ---------------------------------------------------------------------------


@router.get(
    "/api/employees/{employee_id}/custom-fields",
    response_model=list[CustomFieldValueOut],
)
def list_employee_custom_field_values(
    employee_id: int,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> list[CustomFieldValueOut]:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        emp = emp_repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")
        # We need the field defs for coercion + the joined values.
        defs_by_id = {f.id: f for f in cf_repo.list_fields(conn, scope)}
        values = cf_repo.list_values_for_employee(conn, scope, employee_id)

    out: list[CustomFieldValueOut] = []
    for v in values:
        field = defs_by_id.get(v.field_id)
        if field is None:
            continue
        out.append(
            CustomFieldValueOut(
                field_id=v.field_id,
                code=v.code,
                name=v.name,
                type=v.type,  # type: ignore[arg-type]
                value=cf_repo.coerce_for_read(field, v.value),
                raw=v.value,
            )
        )
    return out


@router.patch(
    "/api/employees/{employee_id}/custom-fields",
    response_model=list[CustomFieldValueOut],
)
def patch_employee_custom_field_values(
    employee_id: int,
    payload: EmployeeCustomFieldValuesPatch,
    user: Annotated[CurrentUser, ADMIN_OR_HR],
) -> list[CustomFieldValueOut]:
    scope = TenantScope(tenant_id=user.tenant_id)

    with get_engine().begin() as conn:
        emp = emp_repo.get_employee(conn, scope, employee_id)
        if emp is None:
            raise HTTPException(status_code=404, detail="employee not found")

        defs_by_id = {f.id: f for f in cf_repo.list_fields(conn, scope)}
        changed: list[dict[str, object]] = []

        for item in payload.items:
            field = defs_by_id.get(item.field_id)
            if field is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"custom field {item.field_id} not found",
                )
            try:
                stored = cf_repo.coerce_for_store(field, item.value)
            except cf_repo.CoerceError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

            if stored == "":
                cf_repo.clear_value(
                    conn, scope, employee_id=employee_id, field_id=field.id
                )
                changed.append({"code": field.code, "value": None})
            else:
                cf_repo.upsert_value(
                    conn,
                    scope,
                    employee_id=employee_id,
                    field_id=field.id,
                    value=stored,
                )
                changed.append({"code": field.code, "value": stored})

        if changed:
            write_audit(
                conn,
                tenant_id=scope.tenant_id,
                actor_user_id=user.id,
                action="employee.custom_fields.updated",
                entity_type="employee",
                entity_id=str(employee_id),
                after={"changes": changed},
            )

        values = cf_repo.list_values_for_employee(conn, scope, employee_id)

    out: list[CustomFieldValueOut] = []
    for v in values:
        field = defs_by_id.get(v.field_id)
        if field is None:
            continue
        out.append(
            CustomFieldValueOut(
                field_id=v.field_id,
                code=v.code,
                name=v.name,
                type=v.type,  # type: ignore[arg-type]
                value=cf_repo.coerce_for_read(field, v.value),
                raw=v.value,
            )
        )
    return out
