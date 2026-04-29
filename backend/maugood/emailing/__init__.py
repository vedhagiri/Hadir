"""Outbound email subsystem (v1.0 P18).

Module name is ``emailing`` (not ``email``) to avoid shadowing
Python's stdlib ``email`` package — providers below import
``email.mime.*`` directly.
"""

from maugood.emailing.providers import (
    EmailMessage,
    EmailSender,
    GraphSender,
    RecordingSender,
    SmtpSender,
    clear_sender_factory,
    get_sender,
    set_sender_factory,
)

__all__ = [
    "EmailMessage",
    "EmailSender",
    "GraphSender",
    "RecordingSender",
    "SmtpSender",
    "clear_sender_factory",
    "get_sender",
    "set_sender_factory",
]
