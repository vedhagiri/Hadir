"""Request attachment storage + magic-byte MIME validation.

The router invokes ``validate_and_store(...)`` which:

1. Confirms the file's bytes start with one of the recognised magic
   sequences for the allowed types (image/jpeg, image/png, image/gif,
   image/webp, application/pdf, application/zip — the .docx
   container is a ZIP).
2. Enforces the per-tenant size cap (``MAUGOOD_REQUEST_ATTACHMENT_MAX_MB``).
3. Fernet-encrypts the bytes and writes them to
   ``{root}/{tenant_id}/requests/{uuid}.{ext}`` — the same encrypted-
   at-rest pattern as the P6 employee photos.

Reading back goes through ``read_decrypted(file_path)``.

The P14 red line: server-side validation is the source of truth.
The client also enforces both rules to keep the UX honest, but the
server never trusts those checks.
"""

from __future__ import annotations

import logging
import uuid as uuid_lib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from cryptography.fernet import Fernet, InvalidToken

from maugood.config import get_settings
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)


# -- Magic-byte signatures ---------------------------------------------------
# Each entry: (signature bytes, mime, file extension stored on disk).
# We keep the extension stable per type (e.g. always ``.jpg`` for JPEGs)
# so the on-disk layout is predictable; the original filename + the
# operator-supplied ``content_type`` come back in the API response.

_SIGS: tuple[tuple[bytes, str, str], ...] = (
    # JPEG: ff d8 ff
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    # PNG: 89 50 4e 47 0d 0a 1a 0a
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    # GIF87a / GIF89a
    (b"GIF87a", "image/gif", "gif"),
    (b"GIF89a", "image/gif", "gif"),
    # WEBP: RIFF....WEBP — match RIFF + WEBP at offset 8
    # (handled below via offset check)
    # PDF
    (b"%PDF-", "application/pdf", "pdf"),
    # ZIP — covers .docx, .xlsx, .pptx (we only allow .docx through
    # the "sniff" alone here; the router pairs the magic match with
    # the supplied content_type / extension to refuse a foreign zip).
    (b"PK\x03\x04", "application/zip", "zip"),
    (b"PK\x05\x06", "application/zip", "zip"),  # empty zip
)

# Allowed (mime, extension) tuples after the sniff resolves. The router
# additionally checks the operator-supplied content_type matches what
# the bytes claim, so a ".docx" upload that's actually a JPEG is
# rejected even though the underlying type ("image/jpeg") is allowed.
ALLOWED_TYPES: frozenset[str] = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
)


class AttachmentError(ValueError):
    """Raised when an upload fails validation. The router maps this to
    HTTP 400 (or 413 for size) with the message verbatim — operator-
    safe, no PII or path leakage.
    """


@dataclass(frozen=True, slots=True)
class StoredAttachment:
    file_path: str
    detected_mime: str
    on_disk_extension: str
    size_bytes: int


def _sniff(data: bytes) -> Optional[tuple[str, str]]:
    """Return ``(detected_mime, ext)`` for the bytes, or ``None``."""

    for sig, mime, ext in _SIGS:
        if data.startswith(sig):
            return mime, ext
    # WEBP at offset 8 needs a separate test.
    if (
        len(data) >= 12
        and data[:4] == b"RIFF"
        and data[8:12] == b"WEBP"
    ):
        return "image/webp", "webp"
    return None


def _resolve_mime_and_ext(
    *, data: bytes, declared_content_type: str, original_filename: str
) -> tuple[str, str]:
    """Pick the canonical mime + on-disk extension.

    1. Sniff the magic bytes.
    2. If the sniff says ZIP, only accept it when the declared content
       type is ``.docx`` (operator-claimed) — otherwise reject. This
       blocks a generic ZIP being passed off as a Word document.
    3. Otherwise accept the sniffed type if it's in ``ALLOWED_TYPES``.
    """

    sniffed = _sniff(data)
    if sniffed is None:
        raise AttachmentError(
            "unsupported file type — magic bytes don't match any allowed format"
        )
    mime, ext = sniffed

    if mime == "application/zip":
        # Only accept the ZIP if the operator-supplied content type is
        # the docx container. Real Office files always come in with
        # this content type from a browser; bare zips do not.
        docx_mime = (
            "application/vnd.openxmlformats-"
            "officedocument.wordprocessingml.document"
        )
        if declared_content_type != docx_mime and not original_filename.lower().endswith(
            ".docx"
        ):
            raise AttachmentError(
                "ZIP files are only accepted when uploaded as .docx"
            )
        return docx_mime, "docx"

    if mime not in ALLOWED_TYPES:
        raise AttachmentError(f"file type {mime!r} is not allowed")
    return mime, ext


def _attachment_root() -> Path:
    return Path(get_settings().request_attachment_root)


def _max_bytes() -> int:
    mb = max(1, int(get_settings().request_attachment_max_mb))
    return mb * 1024 * 1024


def _fernet() -> Fernet:
    return Fernet(get_settings().fernet_key.encode())


def validate_and_store(
    *,
    scope: TenantScope,
    data: bytes,
    declared_content_type: str,
    original_filename: str,
) -> StoredAttachment:
    """Validate the upload + write it to disk, encrypted-at-rest.

    Raises ``AttachmentError`` on size or type rejection. Caller maps
    that to HTTP 400/413.
    """

    size = len(data)
    max_b = _max_bytes()
    if size == 0:
        raise AttachmentError("empty file")
    if size > max_b:
        # 413 in the router's translation layer.
        raise AttachmentError(
            f"file is {size / 1024 / 1024:.1f}MB; max is "
            f"{max_b / 1024 / 1024:.0f}MB"
        )

    detected_mime, on_disk_ext = _resolve_mime_and_ext(
        data=data,
        declared_content_type=declared_content_type or "",
        original_filename=original_filename or "",
    )

    base = _attachment_root() / str(scope.tenant_id) / "requests"
    base.mkdir(parents=True, exist_ok=True)

    file_id = uuid_lib.uuid4().hex
    path = base / f"{file_id}.{on_disk_ext}"

    cipher = _fernet().encrypt(data)
    path.write_bytes(cipher)

    return StoredAttachment(
        file_path=str(path),
        detected_mime=detected_mime,
        on_disk_extension=on_disk_ext,
        size_bytes=size,
    )


def read_decrypted(file_path: str) -> bytes:
    """Read + Fernet-decrypt the attachment bytes."""

    p = Path(file_path)
    if not p.is_file():
        raise FileNotFoundError(file_path)
    cipher = p.read_bytes()
    try:
        return _fernet().decrypt(cipher)
    except InvalidToken as exc:  # pragma: no cover — defensive
        raise RuntimeError(
            "could not decrypt attachment — Fernet key mismatch?"
        ) from exc


def drop_attachment_file(file_path: str) -> None:
    """Best-effort delete; missing files are silently ignored."""

    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("could not remove attachment %s: %s", file_path, exc)
