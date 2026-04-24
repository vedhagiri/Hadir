"""Compute + store Fernet-encrypted embeddings for employee reference photos.

Hooked into two flows:

* **On photo upload (P6)** — ``enroll_photo(photo_id)`` runs right
  after the DB row is created so the matcher picks it up for the next
  detection. If embedding fails (model not ready, no face in the
  crop), the row stays enrolled-photo-row-without-embedding; the
  matcher ignores it until ``reembed`` retries.
* **On explicit reembed** — ``POST /api/identification/reembed``
  clears every embedding for the tenant and recomputes. Useful after a
  model upgrade.

Uses ``employees.photos.read_decrypted`` to pull the reference JPEG out
of disk encryption, then hands the crop to the analyzer for a single
embedding.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sqlalchemy import select, update
from sqlalchemy.engine import Connection, Engine

from hadir.capture.analyzer import get_analyzer
from hadir.db import employee_photos
from hadir.employees import photos as photos_io
from hadir.identification.embeddings import encrypt_embedding
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class EnrollmentResult:
    enrolled: int
    skipped: int  # photo missing or no face found
    errors: int


def _decode_image(encrypted_bytes: bytes):  # type: ignore[no-untyped-def]
    import cv2  # noqa: PLC0415

    raw = photos_io.decrypt_bytes(encrypted_bytes)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


def compute_embedding_for_file(file_path: str) -> Optional[np.ndarray]:
    """Decrypt the photo on disk → decode JPEG → run recognition.

    Returns ``None`` if the file is unreadable or no face is detected in
    the reference image.
    """

    from pathlib import Path  # noqa: PLC0415

    path = Path(file_path)
    if not path.exists():
        logger.warning("enrollment: file missing at %s", file_path)
        return None
    try:
        encrypted = path.read_bytes()
        img = _decode_image(encrypted)
        if img is None:
            logger.warning("enrollment: could not decode image %s", file_path)
            return None
        return get_analyzer().embed_crop(img)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "enrollment: failed to embed %s: %s", file_path, type(exc).__name__
        )
        return None


def enroll_photo(engine: Engine, scope: TenantScope, photo_id: int) -> bool:
    """Compute and store the embedding for a single photo. Returns True on success."""

    with engine.begin() as conn:
        row = conn.execute(
            select(
                employee_photos.c.id,
                employee_photos.c.employee_id,
                employee_photos.c.file_path,
            ).where(
                employee_photos.c.tenant_id == scope.tenant_id,
                employee_photos.c.id == photo_id,
            )
        ).first()
    if row is None:
        return False

    vec = compute_embedding_for_file(str(row.file_path))
    if vec is None:
        return False

    encrypted = encrypt_embedding(vec)
    with engine.begin() as conn:
        conn.execute(
            update(employee_photos)
            .where(
                employee_photos.c.id == photo_id,
                employee_photos.c.tenant_id == scope.tenant_id,
            )
            .values(embedding=encrypted)
        )

    # Tell the matcher to reload the employee's vectors next time it's
    # asked. Lazy import so the enrollment module stays importable when
    # the matcher singleton hasn't been instantiated yet.
    from hadir.identification.matcher import matcher_cache  # noqa: PLC0415

    matcher_cache.invalidate_employee(int(row.employee_id))
    logger.debug(
        "enrolled photo id=%s employee_id=%s", row.id, row.employee_id
    )
    return True


def _photo_rows_missing_embedding(conn: Connection, scope: TenantScope) -> list[int]:
    rows = conn.execute(
        select(employee_photos.c.id).where(
            employee_photos.c.tenant_id == scope.tenant_id,
            employee_photos.c.embedding.is_(None),
        )
    ).all()
    return [int(r.id) for r in rows]


def enroll_missing(engine: Engine, scope: TenantScope) -> EnrollmentResult:
    """Enroll every photo that doesn't already have an embedding."""

    with engine.begin() as conn:
        photo_ids = _photo_rows_missing_embedding(conn, scope)

    enrolled = skipped = errors = 0
    for pid in photo_ids:
        try:
            if enroll_photo(engine, scope, pid):
                enrolled += 1
            else:
                skipped += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "enrollment: photo %s failed: %s", pid, type(exc).__name__
            )
            errors += 1
    if enrolled or skipped or errors:
        logger.info(
            "enrollment scan: enrolled=%d skipped=%d errors=%d",
            enrolled,
            skipped,
            errors,
        )
    return EnrollmentResult(enrolled=enrolled, skipped=skipped, errors=errors)


def clear_all_embeddings(engine: Engine, scope: TenantScope) -> int:
    """Null out every embedding for the tenant. Returns rows affected."""

    with engine.begin() as conn:
        result = conn.execute(
            update(employee_photos)
            .where(employee_photos.c.tenant_id == scope.tenant_id)
            .values(embedding=None)
        )
    return int(result.rowcount or 0)


def reembed_all(engine: Engine, scope: TenantScope) -> EnrollmentResult:
    """Clear + recompute every embedding for the tenant.

    Used by ``POST /api/identification/reembed``. On big tenants this is
    slow; we do it synchronously for the pilot. v1.0 moves it to a job
    with progress reporting.
    """

    clear_all_embeddings(engine, scope)

    # Invalidate the whole cache once up front — individual enroll_photo
    # calls will repopulate per employee as they finish.
    from hadir.identification.matcher import matcher_cache  # noqa: PLC0415

    matcher_cache.invalidate_all()
    return enroll_missing(engine, scope)
