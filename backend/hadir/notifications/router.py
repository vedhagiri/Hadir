"""FastAPI router — every authenticated user reads / mutates their
own notifications.

Endpoints:

* ``GET /api/notifications`` — list (newest first) + unread count.
* ``POST /api/notifications/{id}/mark-read`` — flip read_at.
* ``POST /api/notifications/mark-all-read`` — bulk variant.
* ``GET /api/notification-preferences`` — list per category (defaults
  filled in for any category the user hasn't customised).
* ``PATCH /api/notification-preferences`` — upsert one row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from hadir.auth.dependencies import CurrentUser, current_user
from hadir.db import get_engine
from hadir.notifications.categories import ALL_CATEGORIES
from hadir.notifications.repository import (
    list_for_user,
    list_preferences,
    mark_all_read as repo_mark_all_read,
    mark_read as repo_mark_read,
    set_preference,
    unread_count_for_user,
)
from hadir.tenants.scope import TenantScope


router = APIRouter(tags=["notifications"])
USER = Depends(current_user)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class NotificationOut(BaseModel):
    id: int
    category: str
    subject: str
    body: str
    link_url: Optional[str] = None
    payload: dict
    read_at: Optional[datetime] = None
    created_at: datetime


class NotificationListResponse(BaseModel):
    items: list[NotificationOut]
    unread_count: int


class NotificationPreferenceOut(BaseModel):
    category: str
    in_app: bool
    email: bool


class PreferenceListResponse(BaseModel):
    items: list[NotificationPreferenceOut]


class PreferencePatchRequest(BaseModel):
    category: str
    in_app: bool
    email: bool


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


@router.get("/api/notifications", response_model=NotificationListResponse)
def list_notifications(
    user: Annotated[CurrentUser, USER],
    limit: int = 50,
) -> NotificationListResponse:
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be 1..200")
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = list_for_user(conn, scope, user_id=user.id, limit=limit)
        unread = unread_count_for_user(conn, scope, user_id=user.id)
    return NotificationListResponse(
        items=[
            NotificationOut(
                id=r.id,
                category=r.category,
                subject=r.subject,
                body=r.body,
                link_url=r.link_url,
                payload=r.payload,
                read_at=r.read_at,
                created_at=r.created_at,
            )
            for r in rows
        ],
        unread_count=unread,
    )


@router.post(
    "/api/notifications/{notification_id}/mark-read",
    status_code=status.HTTP_204_NO_CONTENT,
)
def mark_read_endpoint(
    notification_id: int,
    user: Annotated[CurrentUser, USER],
    response: Response,
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        repo_mark_read(
            conn,
            scope,
            user_id=user.id,
            notification_id=notification_id,
        )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/api/notifications/mark-all-read")
def mark_all_read_endpoint(
    user: Annotated[CurrentUser, USER],
) -> dict:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        n = repo_mark_all_read(conn, scope, user_id=user.id)
    return {"marked": n}


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------


@router.get(
    "/api/notification-preferences", response_model=PreferenceListResponse
)
def list_preferences_endpoint(
    user: Annotated[CurrentUser, USER],
) -> PreferenceListResponse:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        prefs = list_preferences(conn, scope, user_id=user.id)
    return PreferenceListResponse(
        items=[
            NotificationPreferenceOut(
                category=p.category,
                in_app=p.in_app,
                email=p.email,
            )
            for p in prefs
        ]
    )


@router.patch(
    "/api/notification-preferences", response_model=PreferenceListResponse
)
def patch_preference_endpoint(
    payload: PreferencePatchRequest,
    user: Annotated[CurrentUser, USER],
) -> PreferenceListResponse:
    if payload.category not in ALL_CATEGORIES:
        raise HTTPException(status_code=400, detail="unknown category")
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        set_preference(
            conn,
            scope,
            user_id=user.id,
            category=payload.category,  # type: ignore[arg-type]
            in_app=payload.in_app,
            email=payload.email,
        )
        prefs = list_preferences(conn, scope, user_id=user.id)
    return PreferenceListResponse(
        items=[
            NotificationPreferenceOut(
                category=p.category,
                in_app=p.in_app,
                email=p.email,
            )
            for p in prefs
        ]
    )
