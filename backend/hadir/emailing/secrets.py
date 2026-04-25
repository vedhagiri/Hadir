"""Fernet-encrypt outbound-email credentials.

Uses ``HADIR_AUTH_FERNET_KEY`` — the same key the OIDC ``client_secret``
column from P6 uses, since email credentials are auth-adjacent and we
already have an established rotation story for that key. The
photo/RTSP key (``HADIR_FERNET_KEY``) stays focused on biometric +
camera secrets.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from hadir.config import get_settings


def _fernet() -> Fernet:
    return Fernet(get_settings().auth_fernet_key.encode())


def encrypt_secret(plain: str) -> str:
    """Return Fernet ciphertext (str). Empty input → empty output."""

    if not plain:
        return ""
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(cipher: str | None) -> str:
    """Return the plain secret. Empty / None ciphertext → empty string."""

    if not cipher:
        return ""
    try:
        return _fernet().decrypt(cipher.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError(
            "could not decrypt email secret — Fernet key rotated?"
        ) from exc
