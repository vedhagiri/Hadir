"""Pydantic schemas for the custom-fields API."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


FieldType = Literal["text", "number", "date", "select"]
ALLOWED_TYPES: tuple[FieldType, ...] = ("text", "number", "date", "select")


class CustomFieldResponse(BaseModel):
    id: int
    tenant_id: int
    name: str
    code: str
    type: FieldType
    options: Optional[list[str]] = None
    required: bool
    display_order: int


class CustomFieldCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # ``code`` is the stable identifier the Excel import matches on.
    # Constrained to a SQL-friendly slug so operators don't accidentally
    # ship a header that's awkward to type in Excel ("Badge Number" →
    # ``badge_number``).
    code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    type: FieldType
    options: Optional[list[str]] = None
    required: bool = False

    @model_validator(mode="after")
    def _check_options(self) -> "CustomFieldCreateRequest":
        if self.type == "select":
            if not self.options:
                raise ValueError("select fields require a non-empty options list")
            cleaned = [o.strip() for o in self.options if o and o.strip()]
            if not cleaned:
                raise ValueError("select fields require at least one non-empty option")
            if len(cleaned) != len(set(cleaned)):
                raise ValueError("select options must be unique")
            self.options = cleaned
        else:
            # Drop options entirely for non-select types so the DB row
            # stays NULL — keeps the CHECK and the API surface honest.
            self.options = None
        return self


class CustomFieldPatchRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    options: Optional[list[str]] = None
    required: Optional[bool] = None
    display_order: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _clean(self) -> "CustomFieldPatchRequest":
        # If options present, normalise like the create request.
        if self.options is not None:
            cleaned = [o.strip() for o in self.options if o and o.strip()]
            if not cleaned:
                raise ValueError("options must contain at least one non-empty entry")
            if len(cleaned) != len(set(cleaned)):
                raise ValueError("options must be unique")
            self.options = cleaned
        return self


class ReorderItem(BaseModel):
    id: int
    display_order: int = Field(ge=0)


class ReorderRequest(BaseModel):
    items: list[ReorderItem] = Field(min_length=1, max_length=200)


class CustomFieldValueOut(BaseModel):
    field_id: int
    code: str
    name: str
    type: FieldType
    value: Any  # text | number | date string | str (one of options)
    raw: str  # always the stored text — useful for round-tripping inputs


class CustomFieldValuePatchItem(BaseModel):
    field_id: int
    # ``None`` clears the value (deletes the row); otherwise stored as text.
    value: Optional[Any] = None


class EmployeeCustomFieldValuesPatch(BaseModel):
    items: list[CustomFieldValuePatchItem] = Field(default_factory=list, max_length=200)
