"""Pure state-machine tests for v1.0 P13.

Hits ``maugood.requests.state_machine`` directly — no DB, no HTTP.
Fast, focused, exhaustive over the eight states.
"""

from __future__ import annotations

import pytest

from maugood.requests import state_machine as sm


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------


def test_cancel_from_submitted_returns_cancelled() -> None:
    assert sm.cancel("submitted") == "cancelled"


@pytest.mark.parametrize(
    "status",
    [
        "manager_approved",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
        "cancelled",
    ],
)
def test_cancel_from_other_states_raises(status: str) -> None:
    with pytest.raises(sm.InvalidTransition):
        sm.cancel(status)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# manager_decide
# ---------------------------------------------------------------------------


def test_manager_approve_routes_to_manager_approved() -> None:
    assert sm.manager_decide("submitted", "approve") == "manager_approved"


def test_manager_reject_is_terminal() -> None:
    next_state = sm.manager_decide("submitted", "reject")
    assert next_state == "manager_rejected"
    assert sm.is_terminal(next_state)


@pytest.mark.parametrize(
    "status",
    [
        "manager_approved",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
        "cancelled",
    ],
)
def test_manager_decide_after_submitted_raises(status: str) -> None:
    with pytest.raises(sm.InvalidTransition):
        sm.manager_decide(status, "approve")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# hr_decide
# ---------------------------------------------------------------------------


def test_hr_decide_only_allowed_after_manager_approved() -> None:
    assert sm.hr_decide("manager_approved", "approve") == "hr_approved"
    assert sm.hr_decide("manager_approved", "reject") == "hr_rejected"


@pytest.mark.parametrize(
    "status",
    [
        "submitted",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
        "cancelled",
    ],
)
def test_hr_decide_from_other_states_raises(status: str) -> None:
    """Manager rejection is terminal — HR can never see it (red line)."""

    with pytest.raises(sm.InvalidTransition):
        sm.hr_decide(status, "approve")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# admin_override
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", list(sm.ALL_STATUSES))
def test_admin_override_allowed_from_every_state(status: str) -> None:
    assert (
        sm.admin_override(status, "approve")  # type: ignore[arg-type]
        == "admin_approved"
    )
    assert (
        sm.admin_override(status, "reject")  # type: ignore[arg-type]
        == "admin_rejected"
    )


def test_admin_override_unknown_decision_raises() -> None:
    with pytest.raises(sm.InvalidTransition):
        sm.admin_override("submitted", "shrug")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# is_terminal
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status",
    [
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "admin_approved",
        "admin_rejected",
        "cancelled",
    ],
)
def test_is_terminal_true_for_terminal_states(status: str) -> None:
    assert sm.is_terminal(status)  # type: ignore[arg-type]


@pytest.mark.parametrize("status", ["submitted", "manager_approved"])
def test_is_terminal_false_for_open_states(status: str) -> None:
    assert not sm.is_terminal(status)  # type: ignore[arg-type]
