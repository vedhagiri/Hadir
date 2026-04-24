"""Encrypted-at-rest photo storage.

Every image byte on disk is Fernet-encrypted with ``HADIR_FERNET_KEY`` —
opening one of these files in a browser or viewer produces garbage, by
design. Decryption happens only when the app streams the image back to
an authenticated Admin through the photos GET endpoint.

File layout (per PROJECT_CONTEXT §12 — biometric-at-rest encryption):

    /data/faces/{tenant_id}/{employee_code}/{angle}/{uuid}.jpg

The DB row in ``employee_photos`` carries the plain ``file_path`` (the
path itself isn't sensitive — only the contents are).
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Connection

from hadir.config import get_settings
from hadir.db import employee_photos
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

ALLOWED_ANGLES: tuple[str, ...] = ("front", "left", "right", "other")
DEFAULT_ANGLE: str = "front"

# Filenames on disk are UUIDs we generate — we don't echo the operator's
# filename to disk because (a) it could contain path traversal, and (b)
# it leaks the employee_code to anyone who ever got at the raw volume.
_FILENAME_SUFFIX = ".jpg"

# Matches OM0097.jpg, OM0097_front.jpg, OM0097_left.jpg, OM0097_right.jpg,
# OM0097_other.jpg. Case-insensitive on the angle suffix only.
_FILENAME_PARSE_RE = re.compile(
    r"^(?P<code>[A-Za-z0-9][A-Za-z0-9_\-]*?)(?:_(?P<angle>front|left|right|other))?\.(?:jpg|jpeg|png)$",
    re.IGNORECASE,
)


# --- Fernet helpers ---------------------------------------------------------


def _fernet() -> Fernet:
    """Return the process-wide Fernet from settings.

    Cheap to construct (Fernet is a thin wrapper over an AES key); we don't
    bother caching it. ``HADIR_FERNET_KEY`` must be a valid urlsafe-base64
    32-byte key (use ``Fernet.generate_key()`` to mint one).
    """

    settings = get_settings()
    try:
        return Fernet(settings.fernet_key.encode("utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "HADIR_FERNET_KEY is missing or malformed. "
            "Generate one with Fernet.generate_key()."
        ) from exc


def encrypt_bytes(plain: bytes) -> bytes:
    return _fernet().encrypt(plain)


def decrypt_bytes(cipher: bytes) -> bytes:
    try:
        return _fernet().decrypt(cipher)
    except InvalidToken as exc:
        raise RuntimeError(
            "stored photo could not be decrypted — key rotated?"
        ) from exc


# --- Filename parsing -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ParsedFilename:
    employee_code: str
    angle: str  # always one of ALLOWED_ANGLES


def parse_filename(name: str) -> Optional[ParsedFilename]:
    """Return (code, angle) parsed from a folder-dump filename, or None.

    Rules (PROJECT_CONTEXT §3):
      OM0097.jpg           → front
      OM0097_front.jpg     → front
      OM0097_left.jpg      → left
      OM0097_right.jpg     → right
      OM0097_other.jpg     → other
    """

    stripped = Path(name).name  # drop any accidental leading path
    m = _FILENAME_PARSE_RE.match(stripped)
    if m is None:
        return None
    code = m.group("code")
    angle_raw = m.group("angle")
    angle = (angle_raw or DEFAULT_ANGLE).lower()
    if angle not in ALLOWED_ANGLES:
        return None
    return ParsedFilename(employee_code=code, angle=angle)


# --- Disk layout ------------------------------------------------------------


def storage_dir(tenant_id: int, employee_code: str, angle: str) -> Path:
    settings = get_settings()
    return (
        Path(settings.faces_storage_path)
        / str(tenant_id)
        / employee_code
        / angle
    )


def write_encrypted(
    tenant_id: int, employee_code: str, angle: str, plain_bytes: bytes
) -> str:
    """Encrypt ``plain_bytes`` and write to disk. Returns the absolute path."""

    if angle not in ALLOWED_ANGLES:
        raise ValueError(f"invalid angle: {angle}")
    directory = storage_dir(tenant_id, employee_code, angle)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{_FILENAME_SUFFIX}"
    path = directory / filename
    path.write_bytes(encrypt_bytes(plain_bytes))
    return str(path)


def read_decrypted(file_path: str) -> bytes:
    """Read a stored image, decrypt, and return the original bytes."""

    return decrypt_bytes(Path(file_path).read_bytes())


# --- DB helpers -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PhotoRow:
    id: int
    employee_id: int
    angle: str
    file_path: str


def create_photo_row(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    angle: str,
    file_path: str,
    approved_by_user_id: Optional[int],
) -> int:
    """Insert an ``employee_photos`` row. Pilot-approved by whoever ingested it."""

    from sqlalchemy import func  # local import keeps this module light

    new_id = conn.execute(
        insert(employee_photos)
        .values(
            tenant_id=scope.tenant_id,
            employee_id=employee_id,
            angle=angle,
            file_path=file_path,
            approved_by_user_id=approved_by_user_id,
            approved_at=func.now() if approved_by_user_id is not None else None,
        )
        .returning(employee_photos.c.id)
    ).scalar_one()
    return int(new_id)


def list_photos_for_employee(
    conn: Connection, scope: TenantScope, employee_id: int
) -> list[PhotoRow]:
    rows = conn.execute(
        select(
            employee_photos.c.id,
            employee_photos.c.employee_id,
            employee_photos.c.angle,
            employee_photos.c.file_path,
        )
        .where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.employee_id == employee_id,
        )
        .order_by(employee_photos.c.id.asc())
    ).all()
    return [
        PhotoRow(
            id=int(r.id),
            employee_id=int(r.employee_id),
            angle=str(r.angle),
            file_path=str(r.file_path),
        )
        for r in rows
    ]


def get_photo(
    conn: Connection, scope: TenantScope, *, photo_id: int, employee_id: int
) -> Optional[PhotoRow]:
    row = conn.execute(
        select(
            employee_photos.c.id,
            employee_photos.c.employee_id,
            employee_photos.c.angle,
            employee_photos.c.file_path,
        )
        .where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.id == photo_id,
            employee_photos.c.employee_id == employee_id,
        )
    ).first()
    if row is None:
        return None
    return PhotoRow(
        id=int(row.id),
        employee_id=int(row.employee_id),
        angle=str(row.angle),
        file_path=str(row.file_path),
    )


def delete_photo_row(
    conn: Connection, scope: TenantScope, *, photo_id: int
) -> Optional[str]:
    """Remove the DB row and return its file_path (for on-disk cleanup)."""

    row = conn.execute(
        select(employee_photos.c.file_path).where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.id == photo_id,
        )
    ).first()
    if row is None:
        return None
    conn.execute(
        delete(employee_photos).where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.id == photo_id,
        )
    )
    return str(row.file_path)
