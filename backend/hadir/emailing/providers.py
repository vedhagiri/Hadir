"""Outbound email providers — SMTP + Microsoft Graph.

Both implement the ``EmailSender`` protocol; the runner / test-send
endpoints pick an instance by reading ``email_config`` and asking
``get_sender(config)`` for the right shape. A pluggable factory
(``set_sender_factory``) lets the test suite swap in a recording
sender without monkey-patching imports.

We deliberately avoid the ``msal`` SDK for Graph — a single
client-credentials POST + a single ``/sendMail`` REST call covers
the whole need without dragging the dependency in.
"""

from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass, field
from email.message import EmailMessage as PyEmailMessage
from typing import Callable, Optional, Protocol

import httpx

from hadir.emailing.secrets import decrypt_secret

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class EmailMessage:
    """Provider-agnostic outbound message."""

    subject: str
    html: str
    text: str
    to: tuple[str, ...]
    from_address: str
    from_name: str = ""
    # Each attachment is ``(filename, content_type, bytes)``.
    attachments: tuple[tuple[str, str, bytes], ...] = ()


class EmailSender(Protocol):
    """Send a single message. Raises on transport / provider error."""

    def send(self, message: EmailMessage) -> None: ...


# ---------------------------------------------------------------------------
# SMTP
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SmtpConfig:
    host: str
    port: int
    username: str
    password: str
    use_tls: bool


class SmtpSender:
    """Plain ``smtplib.SMTP`` sender — TLS optional, login optional."""

    def __init__(self, config: SmtpConfig) -> None:
        self._config = config

    def send(self, message: EmailMessage) -> None:
        msg = _to_python_email(message)
        cfg = self._config
        with smtplib.SMTP(cfg.host, cfg.port, timeout=30) as smtp:
            smtp.ehlo()
            if cfg.use_tls:
                smtp.starttls()
                smtp.ehlo()
            if cfg.username:
                smtp.login(cfg.username, cfg.password)
            smtp.send_message(msg)
        # Never log message body or recipient credentials. Recipient
        # addresses are PII-light and useful for ops; log only count.
        logger.info(
            "smtp send: to=%d subject=%r host=%s",
            len(message.to),
            message.subject,
            cfg.host,
        )


def _to_python_email(m: EmailMessage) -> PyEmailMessage:
    msg = PyEmailMessage()
    if m.from_name:
        msg["From"] = f"{m.from_name} <{m.from_address}>"
    else:
        msg["From"] = m.from_address
    msg["To"] = ", ".join(m.to)
    msg["Subject"] = m.subject
    msg.set_content(m.text or "(no text body)")
    msg.add_alternative(m.html, subtype="html")
    for filename, ctype, data in m.attachments:
        maintype, _, subtype = ctype.partition("/")
        if not subtype:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(
            data, maintype=maintype, subtype=subtype, filename=filename
        )
    return msg


# ---------------------------------------------------------------------------
# Microsoft Graph
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GraphConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    sender_address: str  # the mailbox we send "from" — must be licensed


class GraphSender:
    """Tiny REST client — token exchange + ``/users/{addr}/sendMail``.

    Client-credentials flow against
    ``https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token``
    with ``scope=https://graph.microsoft.com/.default``. We don't
    cache the token between sends in the pilot — every send runs a
    fresh exchange. Token caching is a P19+ optimisation.
    """

    _LOGIN = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    _SEND = "https://graph.microsoft.com/v1.0/users/{addr}/sendMail"

    def __init__(self, config: GraphConfig) -> None:
        self._config = config

    def _get_access_token(self) -> str:
        cfg = self._config
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                self._LOGIN.format(tenant=cfg.tenant_id),
                data={
                    "client_id": cfg.client_id,
                    "client_secret": cfg.client_secret,
                    "grant_type": "client_credentials",
                    "scope": "https://graph.microsoft.com/.default",
                },
            )
            if resp.status_code != 200:
                # Don't dump the body — it can echo back the secret.
                raise RuntimeError(
                    f"graph token exchange failed: {resp.status_code}"
                )
            return resp.json()["access_token"]

    def send(self, message: EmailMessage) -> None:
        token = self._get_access_token()
        body = self._to_graph_payload(message)
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                self._SEND.format(addr=self._config.sender_address),
                json=body,
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code not in (200, 202):
                raise RuntimeError(
                    f"graph sendMail failed: {resp.status_code}"
                )
        logger.info(
            "graph send: to=%d subject=%r",
            len(message.to),
            message.subject,
        )

    def _to_graph_payload(self, m: EmailMessage) -> dict:
        # Graph wants attachments as ``#microsoft.graph.fileAttachment``
        # records with base64 content. Caller supplies bytes.
        import base64  # noqa: PLC0415

        attachments_payload = [
            {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": filename,
                "contentType": ctype,
                "contentBytes": base64.b64encode(data).decode("ascii"),
            }
            for filename, ctype, data in m.attachments
        ]
        return {
            "message": {
                "subject": m.subject,
                "body": {"contentType": "HTML", "content": m.html},
                "toRecipients": [
                    {"emailAddress": {"address": addr}} for addr in m.to
                ],
                "from": {
                    "emailAddress": {
                        "address": m.from_address,
                        "name": m.from_name or m.from_address,
                    }
                },
                "attachments": attachments_payload,
            },
            "saveToSentItems": False,
        }


# ---------------------------------------------------------------------------
# Pluggable factory — production picks SmtpSender / GraphSender from the DB
# row; tests can swap in a recorder via ``set_sender_factory``.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SenderConfig:
    """What ``get_sender`` needs from the ``email_config`` row.

    The router decrypts secrets before constructing this — neither
    ``SmtpSender`` nor ``GraphSender`` ever sees the ciphertext. That
    keeps the encryption surface to a single place (``secrets.py``)
    and makes the providers easy to test with a plain string secret.
    """

    provider: str  # 'smtp' | 'microsoft_graph'
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    smtp_use_tls: bool
    graph_tenant_id: str
    graph_client_id: str
    graph_client_secret: str
    from_address: str
    from_name: str
    enabled: bool


_factory: Optional[Callable[[SenderConfig], EmailSender]] = None


def set_sender_factory(factory: Callable[[SenderConfig], EmailSender]) -> None:
    """Override the production ``get_sender`` resolution. Test-only."""

    global _factory
    _factory = factory


def clear_sender_factory() -> None:
    global _factory
    _factory = None


def _env_file_recorder_path() -> Optional[str]:
    """If ``HADIR_EMAIL_RECORDER_PATH`` is set, every send writes a
    JSON line to that file instead of dispatching. Used by the live
    P18 smoke to capture emails without standing up an SMTP catcher.
    Never honoured in production — operators set the env var only on
    dev / smoke shells.
    """

    import os  # noqa: PLC0415

    return os.environ.get("HADIR_EMAIL_RECORDER_PATH") or None


class _FileRecorder:
    def __init__(self, path: str) -> None:
        self._path = path

    def send(self, message: "EmailMessage") -> None:
        import json  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        # Capture only what's safe to read back later — no plain
        # secret echoes (the message body never carries provider
        # credentials anyway).
        record = {
            "subject": message.subject,
            "to": list(message.to),
            "from_address": message.from_address,
            "from_name": message.from_name,
            "html_excerpt": message.html[:1000],
            "text_excerpt": message.text[:1000],
            "attachments": [
                {
                    "filename": fname,
                    "content_type": ctype,
                    "size_bytes": len(data),
                }
                for fname, ctype, data in message.attachments
            ],
        }
        p = Path(self._path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(json.dumps(record) + "\n")


def get_sender(config: SenderConfig) -> EmailSender:
    """Production resolver — picks SMTP or Graph from ``provider``.

    The runner calls this with a freshly-decrypted ``SenderConfig``
    and passes the returned sender's ``send(...)`` the message.
    Tests install a recording factory via ``set_sender_factory``.
    The dev-only ``HADIR_EMAIL_RECORDER_PATH`` env var is the
    cross-process equivalent — used by the P18 live smoke.
    """

    if _factory is not None:
        return _factory(config)
    recorder_path = _env_file_recorder_path()
    if recorder_path:
        return _FileRecorder(recorder_path)
    if config.provider == "smtp":
        return SmtpSender(
            SmtpConfig(
                host=config.smtp_host,
                port=config.smtp_port,
                username=config.smtp_username,
                password=config.smtp_password,
                use_tls=config.smtp_use_tls,
            )
        )
    if config.provider == "microsoft_graph":
        return GraphSender(
            GraphConfig(
                tenant_id=config.graph_tenant_id,
                client_id=config.graph_client_id,
                client_secret=config.graph_client_secret,
                sender_address=config.from_address,
            )
        )
    raise ValueError(f"unknown email provider: {config.provider!r}")


# ---------------------------------------------------------------------------
# Recording sender — used by tests + the optional dev recorder mode.
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class RecordingSender:
    """Drop-in sender that captures messages instead of dispatching.

    Tests create one of these, install a factory that returns it, run
    the workflow under test, and assert against ``messages``.
    """

    messages: list[EmailMessage] = field(default_factory=list)

    def send(self, message: EmailMessage) -> None:
        self.messages.append(message)
