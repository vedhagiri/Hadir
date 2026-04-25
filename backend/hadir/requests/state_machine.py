"""Pure state machine for the request workflow.

No DB access, no HTTP awareness — given the current ``status`` and the
attempted transition, decide whether it's valid and what the next
status is. Tests can exercise every edge with a single value-in /
value-out call.

States (eight total — see docs/phases/P13.md and BRD §FR-REQ-*):

* ``submitted``           — fresh request awaiting the manager.
* ``manager_approved``    — manager has approved; routes to HR.
* ``manager_rejected``    — TERMINAL. Never escalates to HR.
* ``hr_approved``         — TERMINAL. HR is final unless Admin override.
* ``hr_rejected``         — TERMINAL. HR is final unless Admin override.
* ``admin_approved``      — TERMINAL. Admin override outcome.
* ``admin_rejected``      — TERMINAL. Admin override outcome.
* ``cancelled``           — TERMINAL. Employee cancellation (only allowed
                            while ``status=submitted``).

Transitions:

* ``cancel``           : ``submitted`` → ``cancelled``                          (Employee, own only)
* ``manager_decide``   : ``submitted`` → ``manager_approved`` | ``manager_rejected``
* ``hr_decide``        : ``manager_approved`` → ``hr_approved`` | ``hr_rejected``
* ``admin_override``   : any state → ``admin_approved`` | ``admin_rejected``    (mandatory comment)
"""

from __future__ import annotations

from typing import Literal

Status = Literal[
    "submitted",
    "manager_approved",
    "manager_rejected",
    "hr_approved",
    "hr_rejected",
    "admin_approved",
    "admin_rejected",
    "cancelled",
]

Decision = Literal["approve", "reject"]

ALL_STATUSES: tuple[Status, ...] = (
    "submitted",
    "manager_approved",
    "manager_rejected",
    "hr_approved",
    "hr_rejected",
    "admin_approved",
    "admin_rejected",
    "cancelled",
)

# Terminal states — no further transition allowed except by Admin override,
# which is universally allowed.
TERMINAL_STATUSES: frozenset[Status] = frozenset(
    {
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
        "cancelled",
    }
)


class InvalidTransition(Exception):
    """Raised when an actor attempts an illegal state transition.

    The router translates this into HTTP 409 with the message verbatim
    so the caller sees a clear "why" without leaking internals.
    """


def is_terminal(status: Status) -> bool:
    return status in TERMINAL_STATUSES


def cancel(current: Status) -> Status:
    if current != "submitted":
        raise InvalidTransition(
            f"Cannot cancel a request with status {current!r} — "
            "cancellation is only allowed while the request is "
            "still ``submitted``."
        )
    return "cancelled"


def manager_decide(current: Status, decision: Decision) -> Status:
    if current != "submitted":
        raise InvalidTransition(
            f"Cannot manager-decide on a request with status {current!r} — "
            "the manager can only act while the request is ``submitted``."
        )
    if decision not in ("approve", "reject"):
        raise InvalidTransition(f"Unknown decision {decision!r}.")
    return "manager_approved" if decision == "approve" else "manager_rejected"


def hr_decide(current: Status, decision: Decision) -> Status:
    if current != "manager_approved":
        raise InvalidTransition(
            f"Cannot HR-decide on a request with status {current!r} — "
            "HR can only act after the manager has approved."
        )
    if decision not in ("approve", "reject"):
        raise InvalidTransition(f"Unknown decision {decision!r}.")
    return "hr_approved" if decision == "approve" else "hr_rejected"


def admin_override(current: Status, decision: Decision) -> Status:
    """Admin override is universally allowed — even on terminal rows.

    Per BRD FR-REQ-006 the Admin can flip a previously-rejected request
    or rubber-stamp a still-pending one. The mandatory comment
    requirement is enforced at the API layer (``ValueError`` on empty
    comment) — the state machine itself doesn't see the comment.
    """

    if decision not in ("approve", "reject"):
        raise InvalidTransition(f"Unknown decision {decision!r}.")
    return "admin_approved" if decision == "approve" else "admin_rejected"
