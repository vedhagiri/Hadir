"""Encrypted-at-rest photo storage.

Every image byte on disk is Fernet-encrypted with ``MAUGOOD_FERNET_KEY`` —
opening one of these files in a browser or viewer produces garbage, by
design. Decryption happens only when the app streams the image back to
an authenticated Admin through the photos GET endpoint.

File layout (per PROJECT_CONTEXT §12 — biometric-at-rest encryption):

    /data/faces/{tenant_id}/{employee_code}/{angle}/{uuid}.jpg

The DB row in ``employee_photos`` carries the plain ``file_path`` (the
path itself isn't sensitive — only the contents are).
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, func, insert, select
from sqlalchemy.engine import Connection

from maugood.config import get_settings
from maugood.db import employee_photos
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

ALLOWED_ANGLES: tuple[str, ...] = ("front", "left", "right", "other")
DEFAULT_ANGLE: str = "front"

# --- Reference-image validation (shared across every upload path) ----------
# Every entry point that adds a reference image to an employee — the
# Admin/HR drawer upload, the bulk folder dump, the employee self-upload,
# and the "map unidentified face → reference" copy — funnels through these
# rules. Keep the messages in sync with ``frontend/src/util/photoValidation.ts``.

# At most this many reference images per employee.
MAX_REFERENCE_PHOTOS_PER_EMPLOYEE: int = 10

# Allowed image types, enforced by magic-byte sniff (not extension).
ALLOWED_PHOTO_EXTS: tuple[str, ...] = ("jpg", "jpeg", "png", "webp")

MSG_MAX_PHOTOS: str = (
    f"Maximum {MAX_REFERENCE_PHOTOS_PER_EMPLOYEE} reference images are "
    "allowed per employee. Please remove an existing image before "
    "uploading a new one."
)
MSG_BAD_TYPE: str = (
    "Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed."
)
MSG_DUPLICATE: str = (
    "This image has already been uploaded for this employee."
)
MSG_EMPTY: str = "empty file"


def msg_too_large(max_mb: int) -> str:
    return f"File size exceeds the maximum allowed limit of {max_mb} MB."


def photo_max_bytes() -> int:
    """Per-file size cap in bytes, from ``MAUGOOD_EMPLOYEE_PHOTO_MAX_MB``."""

    return int(get_settings().employee_photo_max_mb) * 1024 * 1024


class PhotoValidationError(ValueError):
    """Raised when a reference image fails validation. ``message`` is the
    operator-facing reason (surfaced verbatim in the rejection list / as
    an HTTP 400 detail) — never carries PII or a filesystem path."""

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
    bother caching it. ``MAUGOOD_FERNET_KEY`` must be a valid urlsafe-base64
    32-byte key (use ``Fernet.generate_key()`` to mint one).
    """

    settings = get_settings()
    try:
        return Fernet(settings.fernet_key.encode("utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "MAUGOOD_FERNET_KEY is missing or malformed. "
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


# --- Image validation -------------------------------------------------------


def sniff_image_ext(data: bytes) -> Optional[str]:
    """Return the image type ('jpg' | 'png' | 'webp') from magic bytes,
    or ``None`` when the bytes aren't an allowed image. Extension and
    declared content-type are never trusted — only the bytes."""

    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def content_sha256(data: bytes) -> str:
    """SHA-256 of the *plaintext* image bytes — the duplicate key. Computed
    on the decrypted content so the same picture dedupes regardless of the
    Fernet nonce (every encryption produces different ciphertext)."""

    return hashlib.sha256(data).hexdigest()


def validate_image_bytes(data: bytes, *, max_bytes: Optional[int] = None) -> str:
    """Validate one reference image's raw bytes. Returns the sniffed type
    on success; raises ``PhotoValidationError`` (with an operator-facing
    message) otherwise. Order is cheapest-first: empty → size → type."""

    if not data:
        raise PhotoValidationError(MSG_EMPTY)
    cap = max_bytes if max_bytes is not None else photo_max_bytes()
    if len(data) > cap:
        raise PhotoValidationError(msg_too_large(cap // (1024 * 1024)))
    ext = sniff_image_ext(data)
    if ext is None:
        raise PhotoValidationError(MSG_BAD_TYPE)
    return ext


def count_photos(conn: Connection, scope: TenantScope, employee_id: int) -> int:
    """Current number of reference photos for an employee (all statuses)."""

    return int(
        conn.execute(
            select(func.count())
            .select_from(employee_photos)
            .where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.employee_id == employee_id,
            )
        ).scalar_one()
    )


def photo_hash_exists(
    conn: Connection, scope: TenantScope, employee_id: int, sha256: str
) -> bool:
    """True when a reference photo with this content hash already exists
    for the employee — the duplicate-upload guard."""

    return (
        conn.execute(
            select(employee_photos.c.id)
            .where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.employee_id == employee_id,
                employee_photos.c.content_sha256 == sha256,
            )
            .limit(1)
        ).first()
        is not None
    )


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
    uploaded_by_user_id: Optional[int] = None
    approval_status: str = "approved"


def create_photo_row(
    conn: Connection,
    scope: TenantScope,
    *,
    employee_id: int,
    angle: str,
    file_path: str,
    approved_by_user_id: Optional[int],
    uploaded_by_user_id: Optional[int] = None,
    approval_status: str = "approved",
    content_sha256: Optional[str] = None,
) -> int:
    """Insert an ``employee_photos`` row.

    ``uploaded_by_user_id`` (migration 0036) records who actually
    submitted the bytes — drives the Employee self-delete gate.
    ``approval_status`` defaults to 'approved' for the historic
    Admin/HR ingest path; the Employee self-upload route passes
    'pending' so the matcher cache ignores it until an Admin/HR
    flips it via the approval queue. ``content_sha256`` (migration
    0070) is the plaintext-content hash used for duplicate detection.
    """

    new_id = conn.execute(
        insert(employee_photos)
        .values(
            tenant_id=scope.tenant_id,
            employee_id=employee_id,
            angle=angle,
            file_path=file_path,
            approved_by_user_id=approved_by_user_id,
            approved_at=func.now() if approved_by_user_id is not None else None,
            uploaded_by_user_id=uploaded_by_user_id,
            approval_status=approval_status,
            content_sha256=content_sha256,
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
            employee_photos.c.uploaded_by_user_id,
            employee_photos.c.approval_status,
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
            uploaded_by_user_id=(
                int(r.uploaded_by_user_id)
                if r.uploaded_by_user_id is not None
                else None
            ),
            approval_status=str(r.approval_status),
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
            employee_photos.c.uploaded_by_user_id,
            employee_photos.c.approval_status,
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
        uploaded_by_user_id=(
            int(row.uploaded_by_user_id)
            if row.uploaded_by_user_id is not None
            else None
        ),
        approval_status=str(row.approval_status),
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
