"""Push-token minting, hashing, and the global token → tenant registry.

A push device authenticates with nothing but the token embedded in the URL
an operator pasted into it. That makes this module the entire security
boundary for the ingest endpoint, so three rules hold:

1. **The plaintext token is never stored.** ``token_hash`` (SHA-256) is what
   the registry and ``attendance_devices`` hold. A database leak therefore
   does not hand an attacker a working push URL.
2. **A Fernet copy is kept only so the operator can re-read the URL** when
   reconfiguring a replacement terminal. Same key as the rest of the
   at-rest encryption (``MAUGOOD_FERNET_KEY``).
3. **The token is never logged** — not on ingest, not on rotation, not in
   an audit row. Log ``device_id`` instead. A token in ``app.log`` is a
   live credential sitting in plaintext on disk.

The registry lives in ``public`` because ingest is anonymous: there is no
session and no tenant cookie, so the token must resolve to a tenant before
any schema can be selected. See ``docs/design/device-push-ingest-plan.md``.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from maugood.cameras.rtsp import decrypt_url as _decrypt
from maugood.cameras.rtsp import encrypt_url as _encrypt
from maugood.db import device_push_tokens

logger = logging.getLogger(__name__)

_HEX = "0123456789abcdef"

# Token shape: ``b1d1-9f3a7`` — four hex, a dash, five hex. Chosen by the
# operator so it stays short enough to type into a terminal's cramped URL
# field. NOTE: that is ~36 bits of entropy. It is adequate only because
# ingest is per-token rate-limited and every rejection is logged; if the
# deployment ever exposes ingest without that throttle, lengthen this.
_GROUPS = (4, 5)


def mint_token() -> str:
    """Return a fresh push token in the ``b1d1-9f3a7`` shape."""

    return "-".join(
        "".join(secrets.choice(_HEX) for _ in range(n)) for n in _GROUPS
    )


def hash_token(token: str) -> str:
    """SHA-256 hex digest — the only form of the token we persist."""

    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


def encrypt_token(token: str) -> str:
    """Fernet ciphertext, so an operator can re-read the URL later."""

    return _encrypt(token)


def decrypt_token(ciphertext: str) -> str:
    """Recover the plaintext token for display to an authenticated Admin."""

    return _decrypt(ciphertext)


@dataclass(frozen=True, slots=True)
class TokenRoute:
    """Where an ingest request belongs. Resolved before any schema is set."""

    tenant_id: int
    tenant_schema: str
    device_id: int


def register(
    conn: Connection,
    *,
    token_hash: str,
    tenant_id: int,
    tenant_schema: str,
    device_id: int,
) -> None:
    """Upsert the routing row. Called inside ``tenant_context('public')``."""

    stmt = pg_insert(device_push_tokens).values(
        token_hash=token_hash,
        tenant_id=tenant_id,
        tenant_schema=tenant_schema,
        device_id=device_id,
        revoked_at=None,
    )
    conn.execute(
        stmt.on_conflict_do_update(
            index_elements=[device_push_tokens.c.token_hash],
            set_={
                "tenant_id": stmt.excluded.tenant_id,
                "tenant_schema": stmt.excluded.tenant_schema,
                "device_id": stmt.excluded.device_id,
                "revoked_at": None,
            },
        )
    )


def revoke_for_device(
    conn: Connection, *, tenant_id: int, device_id: int
) -> None:
    """Revoke every token previously issued to this device.

    Rotation revokes rather than deletes so a terminal still posting on the
    old URL resolves to a *revoked* row — which we can log as a stale
    device needing reconfiguration, instead of an indistinguishable
    unknown-token miss.
    """

    conn.execute(
        update(device_push_tokens)
        .where(
            device_push_tokens.c.tenant_id == tenant_id,
            device_push_tokens.c.device_id == device_id,
            device_push_tokens.c.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(tz=timezone.utc))
    )


def delete_for_device(
    conn: Connection, *, tenant_id: int, device_id: int
) -> None:
    """Drop routing rows when the device itself is deleted."""

    conn.execute(
        delete(device_push_tokens).where(
            device_push_tokens.c.tenant_id == tenant_id,
            device_push_tokens.c.device_id == device_id,
        )
    )


def resolve(conn: Connection, token: str) -> Optional[TokenRoute]:
    """Map a raw token to its tenant + device, or ``None``.

    Returns ``None`` for both an unknown token and a revoked one — the
    caller must not distinguish them to the client, or the endpoint
    becomes an oracle for guessing valid tokens.
    """

    row = conn.execute(
        select(
            device_push_tokens.c.tenant_id,
            device_push_tokens.c.tenant_schema,
            device_push_tokens.c.device_id,
            device_push_tokens.c.revoked_at,
        ).where(device_push_tokens.c.token_hash == hash_token(token))
    ).first()

    if row is None or row.revoked_at is not None:
        return None

    return TokenRoute(
        tenant_id=int(row.tenant_id),
        tenant_schema=str(row.tenant_schema),
        device_id=int(row.device_id),
    )
