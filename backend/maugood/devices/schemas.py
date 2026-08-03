"""Pydantic request/response models for ``/api/devices``.

Credentials (``username`` / ``password``) are inbound-only — they appear
on Create/Patch bodies but NEVER on any response. Responses expose host,
port, and the device-read serial only. Mirrors the camera rule where
``rtsp_url`` is write-only and responses carry ``rtsp_host``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

Driver = Literal["hikvision", "dahua", "generic"]
EnrollmentScope = Literal["all", "department", "zone"]
HealthStatus = Literal["online", "unreachable", "unknown"]


class DeviceCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=200)
    driver: Driver = "hikvision"
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=80, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=256)
    door_no: Optional[str] = Field(default=None, max_length=32)
    enrollment_scope: EnrollmentScope = "all"
    enabled: bool = True


class DevicePatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    location: Optional[str] = Field(default=None, max_length=200)
    driver: Optional[Driver] = None
    host: Optional[str] = Field(default=None, min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    # Send BOTH to rotate credentials; omit to keep the stored cipher.
    username: Optional[str] = Field(default=None, min_length=1, max_length=120)
    password: Optional[str] = Field(default=None, min_length=1, max_length=256)
    door_no: Optional[str] = Field(default=None, max_length=32)
    enrollment_scope: Optional[EnrollmentScope] = None
    enabled: Optional[bool] = None


class DeviceOut(BaseModel):
    id: int
    name: str
    location: str
    driver: str
    host: str
    port: int
    door_no: Optional[str]
    serial_number: Optional[str]
    model: Optional[str]
    firmware: Optional[str]
    enabled: bool
    enrollment_scope: str
    health_status: str
    users_synced: int
    last_user_sync_at: Optional[datetime]
    last_seen_at: Optional[datetime]
    created_at: datetime


class DeviceListOut(BaseModel):
    items: list[DeviceOut]


class SyncUsersResult(BaseModel):
    synced: int
    unmapped: int
    reachable: bool


class DeviceUserOut(BaseModel):
    id: int
    device_user_id: str
    name: Optional[str]
    card_no: Optional[str]
    employee_id: Optional[int]
    mapping_status: str
    face_synced: bool
    synced_at: Optional[datetime]


class DeviceUserListOut(BaseModel):
    items: list[DeviceUserOut]
