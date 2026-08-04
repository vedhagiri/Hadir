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
    """Push registration. Name, an optional label, and nothing else.

    No host, port, username or password: the terminal dials us, so we never
    need to reach it. Its serial, model and firmware are learned from the
    first event it posts.
    """

    name: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=200)
    driver: Driver = "hikvision"
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
    host: Optional[str]
    port: Optional[int]
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
    # Push mode.
    connection_mode: str
    # The complete URL an operator pastes into the terminal. Contains the
    # token, so it is only ever returned to an authenticated Admin — never
    # logged, never in an audit row.
    push_url: Optional[str] = None
    push_token: Optional[str] = None
    last_event_at: Optional[datetime] = None
    clock_suspect: bool = False
    reported_device_name: Optional[str] = None
    users_total: int = 0
    users_unmapped: int = 0


class DeviceListOut(BaseModel):
    items: list[DeviceOut]


class MapDeviceUserIn(BaseModel):
    """Point a discovered device person at an employee. ``None`` unmaps."""

    employee_id: Optional[int] = None


class MapDeviceUserResult(BaseModel):
    device_user_id: str
    employee_id: Optional[int]
    # Taps that arrived before the mapping existed and have now been
    # replayed into attendance.
    replayed: int


class AutoMapResult(BaseModel):
    mapped: int
    still_unmapped: int
    replayed: int


class DeviceEventOut(BaseModel):
    id: int
    device_user_id: str
    person_name: Optional[str]
    event_serial: str
    occurred_at: datetime
    received_at: datetime
    verify_mode: Optional[str]
    direction: Optional[str]
    status: str
    clock_suspect: bool
    employee_id: Optional[int]


class DeviceEventListOut(BaseModel):
    items: list[DeviceEventOut]


class SyncUsersResult(BaseModel):
    synced: int
    unmapped: int
    reachable: bool


class ResyncResult(BaseModel):
    """Outcome of "Sync now" on a push device.

    ``still_unmapped`` is not a failure — those taps are parked waiting for
    an operator to map their person, and only mapping can clear them.
    """

    adopted: int
    retried: int
    processed: int
    still_unmapped: int


class DeviceUserOut(BaseModel):
    id: int
    device_user_id: str
    name: Optional[str]
    card_no: Optional[str]
    employee_id: Optional[int]
    mapping_status: str
    face_synced: bool
    synced_at: Optional[datetime]
    first_seen_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    taps_count: int = 0
    source: str = "sync"
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None


class DeviceUserListOut(BaseModel):
    items: list[DeviceUserOut]
