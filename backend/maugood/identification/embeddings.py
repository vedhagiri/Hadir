"""Fernet encryption helpers for 512-float-32 face embeddings.

Embeddings are biometric data and live encrypted at rest (PROJECT_CONTEXT
§12 / pilot-plan red line). Plaintext vectors exist only:

* inside the analyzer process after a frame/crop runs through
  ``buffalo_l`` recognition;
* inside the ``MatcherCache`` in-memory dict after decrypt.

They never touch disk, logs, or API responses in plaintext.
"""

from __future__ import annotations

import numpy as np
from cryptography.fernet import Fernet, InvalidToken

from maugood.config import get_settings

# Fixed by InsightFace buffalo_l recognition head. Store in the constant
# so a rotate or a model swap surfaces as a loud ValueError rather than
# silent mis-decoding.
EMBEDDING_DIM = 512


def _fernet() -> Fernet:
    settings = get_settings()
    try:
        return Fernet(settings.fernet_key.encode("utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "MAUGOOD_FERNET_KEY is missing or malformed for embedding encryption."
        ) from exc


def encrypt_embedding(vec: np.ndarray) -> bytes:
    """Return the Fernet ciphertext of a float-32 embedding.

    We coerce to ``float32`` here so callers don't have to care whether
    the vector came from InsightFace (already float32) or a test stub
    (often float64).
    """

    if vec.ndim != 1:
        raise ValueError(f"embedding must be 1-D, got shape {vec.shape}")
    if vec.shape[0] != EMBEDDING_DIM:
        raise ValueError(
            f"embedding must be {EMBEDDING_DIM}-D, got {vec.shape[0]}"
        )
    payload = vec.astype(np.float32, copy=False).tobytes()
    return _fernet().encrypt(payload)


def decrypt_embedding(token: bytes) -> np.ndarray:
    """Decrypt and reshape the stored token back into a float-32 vector."""

    try:
        raw = _fernet().decrypt(token)
    except InvalidToken as exc:
        raise RuntimeError("stored embedding could not be decrypted") from exc
    vec = np.frombuffer(raw, dtype=np.float32)
    if vec.shape[0] != EMBEDDING_DIM:
        raise RuntimeError(
            f"decrypted embedding has unexpected shape {vec.shape}"
        )
    # frombuffer returns a read-only view; callers expect a writeable copy.
    return vec.copy()
