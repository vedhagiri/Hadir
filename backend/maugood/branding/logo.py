"""Tenant logo storage.

PNG or SVG only, validated by **magic bytes** (not filename / MIME),
max 2 MB. Stored at
``/data/branding/{tenant_id}/logo.{ext}``. Served via an
auth-required endpoint so a leaked URL alone can't surface another
tenant's branding asset.

PNG uploads larger than ``_MAX_DIMENSION`` on the longest side are
**resized down** (aspect ratio preserved, LANCZOS resample) before
being written to disk so an operator dragging a 4000×4000 marketing
asset still gets a sensibly-sized brand row. SVGs are vector and
pass through untouched. Smaller PNGs are written byte-for-byte —
no re-encode — so a deliberately-tuned 256×256 logo isn't second-
guessed.

There's no Fernet encryption-at-rest here. The face data we encrypt
(employee photos, capture crops) is genuinely sensitive; the tenant
logo is intentionally public-facing inside the tenant. We still
keep the directory inside the same ``/data`` volume so backups and
deprovisioning treat it uniformly.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger(__name__)


_LOGO_ROOT = Path("/data/branding")
_MAX_BYTES = 2 * 1024 * 1024  # 2 MB upload cap (was 200 KB pre-P28.x)
# Longest-side cap for PNG storage. The sidebar / topbar / report
# letterheads all render the logo well under this; 512 leaves enough
# resolution for high-DPI screens without wasting bytes on a 4 K
# marketing PNG.
_MAX_DIMENSION = 512

# PNG: 89 50 4E 47 0D 0A 1A 0A
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True, slots=True)
class StoredLogo:
    path: Path
    ext: Literal["png", "svg"]
    size_bytes: int


class LogoValidationError(ValueError):
    """Raised when an upload fails validation. Caller surfaces as 400."""


def _maybe_resize_png(content: bytes) -> bytes:
    """If the PNG exceeds ``_MAX_DIMENSION`` on its longest side, resize
    down preserving aspect ratio and re-encode. Otherwise return the
    original bytes untouched (so well-tuned small PNGs round-trip
    byte-for-byte through upload + serve).

    Pillow is imported lazily — the rest of the module works on
    minimal installs where Pillow happens to be missing, and we only
    pay the import cost on actual logo uploads (rare)."""

    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:  # pragma: no cover — Pillow ships in our base image
        logger.warning(
            "logo: Pillow not available, skipping resize. "
            "Install Pillow or add it to backend dependencies."
        )
        return content

    try:
        img = Image.open(BytesIO(content))
        # Read dimensions without consuming pixel data.
        width, height = img.size
    except Exception as exc:  # noqa: BLE001
        # The magic-byte check already accepted this as a PNG; if Pillow
        # rejects it, store as-is rather than failing the upload — the
        # browser may still render it, and re-encoding wouldn't help.
        logger.warning(
            "logo: Pillow could not open uploaded PNG (%s); storing as-is",
            type(exc).__name__,
        )
        return content

    if max(width, height) <= _MAX_DIMENSION:
        return content

    # Re-open: Pillow may have lazy-loaded only the header above.
    img = Image.open(BytesIO(content))
    img.thumbnail((_MAX_DIMENSION, _MAX_DIMENSION), Image.Resampling.LANCZOS)
    out = BytesIO()
    # ``optimize=True`` runs the slower zlib compression — worth it
    # since we save the result once and serve it on every page load.
    img.save(out, format="PNG", optimize=True)
    resized = out.getvalue()
    logger.info(
        "logo: resized PNG from %dx%d (%d bytes) → %dx%d (%d bytes)",
        width,
        height,
        len(content),
        *img.size,
        len(resized),
    )
    return resized


def _detect_extension(content: bytes) -> Literal["png", "svg"]:
    """Sniff the magic bytes. Reject anything other than PNG or SVG."""

    if content.startswith(_PNG_MAGIC):
        return "png"
    # SVG is just XML; accept either ``<?xml`` declaration or the
    # ``<svg`` opening tag. Skip leading whitespace + UTF-8 BOM. We
    # also explicitly check for a closing ``</svg>`` to fail closed
    # against truncated or fake SVG payloads.
    head = content.lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        if b"<svg" in content and b"</svg>" in content:
            return "svg"
        raise LogoValidationError("malformed SVG: missing <svg> tags")
    raise LogoValidationError(
        "unsupported logo format: only PNG and SVG are accepted"
    )


def write_logo(*, tenant_id: int, content: bytes) -> StoredLogo:
    """Validate + persist a new logo. Returns the stored path / ext.

    Replaces any existing logo for the tenant — only one logo per
    tenant is supported (BRD curated-slots philosophy).
    """

    if not content:
        raise LogoValidationError("logo is empty")
    if len(content) > _MAX_BYTES:
        mb = _MAX_BYTES // (1024 * 1024)
        raise LogoValidationError(
            f"logo exceeds {mb} MB limit ({len(content)} bytes)"
        )
    ext = _detect_extension(content)

    # PNG-only resize. SVGs are vector — let CSS scale them.
    if ext == "png":
        content = _maybe_resize_png(content)

    tenant_dir = _LOGO_ROOT / str(tenant_id)
    tenant_dir.mkdir(parents=True, exist_ok=True)

    # Remove any prior logo file (we don't keep history — the audit
    # log carries the change record).
    for existing in tenant_dir.glob("logo.*"):
        try:
            existing.unlink()
        except OSError as exc:  # noqa: BLE001
            logger.warning(
                "logo: failed to remove prior file %s: %s", existing, type(exc).__name__
            )

    target = tenant_dir / f"logo.{ext}"
    target.write_bytes(content)
    return StoredLogo(path=target, ext=ext, size_bytes=len(content))


def read_logo(path_str: str) -> Optional[bytes]:
    """Return the bytes at ``path_str`` if it still exists.

    The path comes from ``tenant_branding.logo_path`` which we wrote
    ourselves, so we don't validate it against the data root again
    here — the writer is the only source of paths in the table.
    """

    p = Path(path_str)
    if not p.exists() or not p.is_file():
        return None
    return p.read_bytes()


def delete_logo(*, tenant_id: int) -> None:
    """Remove every logo file for a tenant. No-op if directory empty."""

    tenant_dir = _LOGO_ROOT / str(tenant_id)
    if tenant_dir.exists():
        try:
            shutil.rmtree(tenant_dir)
        except OSError as exc:  # noqa: BLE001
            logger.warning(
                "logo: failed to remove tenant dir %s: %s",
                tenant_dir,
                type(exc).__name__,
            )


def content_type_for(ext: str) -> str:
    """Map a stored extension back to its HTTP Content-Type."""

    if ext == "png":
        return "image/png"
    if ext == "svg":
        return "image/svg+xml"
    raise ValueError(f"unknown logo extension {ext!r}")
