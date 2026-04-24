"""Password hashing and verification.

Argon2id via ``argon2-cffi`` with library defaults. No plain password is
returned from any function here, and verification swallows mismatch /
invalid-hash errors so they never become part of an exception trace that
could end up in logs.
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# Single shared hasher — configuration is uniform across the app and the
# hasher is safe to share between threads.
_hasher = PasswordHasher()


def hash_password(plain: str) -> str:
    """Return an Argon2id encoded hash for ``plain``."""

    return _hasher.hash(plain)


def verify_password(encoded_hash: str, plain: str) -> bool:
    """Return ``True`` if ``plain`` matches ``encoded_hash``.

    Returns ``False`` for mismatches and for corrupted or non-Argon2 hashes.
    Never raises on wrong password — callers use the boolean and write
    their own audit entries, which must not contain the password itself.
    """

    try:
        _hasher.verify(encoded_hash, plain)
    except (VerifyMismatchError, InvalidHashError):
        return False
    return True
