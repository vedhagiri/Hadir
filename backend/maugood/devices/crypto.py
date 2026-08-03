"""Fernet wrap/unwrap of device credentials.

Same key + scheme as the camera RTSP path (``MAUGOOD_FERNET_KEY``). The
plaintext ``username:password`` lives NOWHERE outside a decrypt-to-use
scope — never in logs, API responses, audit rows, or error messages. If
you ever see it, that's a bug; fix it, don't justify it.
"""

from __future__ import annotations

from maugood.cameras.rtsp import decrypt_url as _decrypt
from maugood.cameras.rtsp import encrypt_url as _encrypt

# Separator between username and password inside the encrypted blob. A
# colon can't appear in the username half because we split once from the
# left, so a password containing ':' round-trips intact.
_SEP = ":"


def encrypt_credentials(username: str, password: str) -> str:
    """Return the Fernet ciphertext token for ``username:password``."""

    return _encrypt(f"{username}{_SEP}{password}")


def decrypt_credentials(token: str) -> tuple[str, str]:
    """Return ``(username, password)`` from a stored token."""

    plain = _decrypt(token)
    username, _, password = plain.partition(_SEP)
    return username, password
