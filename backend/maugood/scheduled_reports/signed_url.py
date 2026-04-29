"""HMAC-signed download tokens for over-threshold reports.

The token format is ``{run_id}.{exp}.{sig}`` (base64url) where
``sig = HMAC-SHA256(key, f"{run_id}:{exp}")``. Compact, no DB
lookup to validate, and rotating ``MAUGOOD_REPORT_SIGNED_URL_SECRET``
invalidates every outstanding token.

Tokens are *not* one-shot — the BRD allows reuse, and we counter
abuse with a per-IP rate limit on the validation endpoint
(``MAUGOOD_REPORT_SIGNED_URL_RATE_LIMIT_PER_MINUTE``). The endpoint
audits every successful access.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from dataclasses import dataclass

from maugood.config import get_settings


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _sign(payload: str, *, secret: bytes) -> str:
    digest = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(digest)


def make_token(*, run_id: int, ttl_seconds: int | None = None) -> str:
    """Build a token good for the configured TTL."""

    settings = get_settings()
    if ttl_seconds is None:
        ttl_seconds = settings.report_signed_url_ttl_days * 24 * 3600
    exp = int(time.time()) + ttl_seconds
    payload = f"{run_id}:{exp}"
    sig = _sign(payload, secret=settings.report_signed_url_secret.encode())
    return f"{run_id}.{exp}.{sig}"


@dataclass(frozen=True, slots=True)
class TokenError(Exception):
    """Translation-friendly token failure — operator-safe message."""

    detail: str


def validate_token(token: str, *, expected_run_id: int) -> None:
    """Raise ``TokenError`` on any tampering, expiry, or run mismatch."""

    settings = get_settings()
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError(detail="malformed token")
    run_str, exp_str, sig = parts
    try:
        run_id = int(run_str)
        exp = int(exp_str)
    except ValueError as exc:
        raise TokenError(detail="malformed token") from exc
    if run_id != expected_run_id:
        raise TokenError(detail="token does not match this run")
    expected_sig = _sign(
        f"{run_id}:{exp}",
        secret=settings.report_signed_url_secret.encode(),
    )
    if not hmac.compare_digest(expected_sig, sig):
        raise TokenError(detail="invalid token signature")
    if exp < int(time.time()):
        raise TokenError(detail="token expired")


def build_download_url(*, base_url: str, run_id: int, token: str) -> str:
    """Concatenate the public endpoint + token. ``base_url`` is the
    operator-configured front-end URL — pulled from
    ``MAUGOOD_OIDC_REDIRECT_BASE_URL`` since that's what the operator
    already configured for outgoing links.
    """

    return f"{base_url}/api/reports/runs/{run_id}/download?token={token}"
