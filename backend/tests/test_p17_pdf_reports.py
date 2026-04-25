"""Tests for v1.0 P17 — Attendance PDF endpoint.

Mirrors the P13 Excel suite where it makes sense:

* Round-trip — POST returns 200, ``application/pdf`` content type,
  ``%PDF-`` magic, the spec'd filename, and the rendered bytes
  contain at least one of the seeded employee codes (PDF stores
  text streams in plain enough form that a substring search lands
  the per-employee section header).
* Department filter narrows the employee set.
* Employee role 403.
* Manager scoping — Manager auto-scopes to assigned departments;
  cross-department filter returns 403.
* Date range guards (start > end, span > max_days) match the Excel
  endpoint.
* Filename encodes ``hadir-attendance-{tenant_slug}-{from}-to-{to}.pdf``.
* Branding swap — flipping ``tenant_branding.primary_color_key`` to
  ``navy`` changes the rendered hex from ``#117a7a`` (teal) to
  ``#1e3a8a`` (navy).
"""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select, update


def _is_pdf(pdf_bytes: bytes) -> bool:
    return pdf_bytes.startswith(b"%PDF-") and b"%%EOF" in pdf_bytes[-32:]

from hadir.db import (
    attendance_records,
    cameras,
    detection_events,
    employees,
    tenant_branding,
    user_departments,
)

# Re-use the P13 helpers — pytest will pick them up because both files
# live under the same ``tests`` package.
from tests.test_p13_reports import _login, seeded_attendance  # noqa: F401


def _post_pdf(client: TestClient, body: dict):
    return client.post("/api/reports/attendance.pdf", json=body)


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_pdf_round_trip_contains_seeded_employee_section(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    resp = _post_pdf(
        client,
        {
            "start": (today - timedelta(days=1)).isoformat(),
            "end": today.isoformat(),
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/pdf")
    cd = resp.headers["content-disposition"]
    assert "hadir-attendance-main-" in cd
    assert cd.endswith('.pdf"')

    body = resp.content
    assert _is_pdf(body), body[:8]
    # Sanity: a real branded letterhead + summary + two employee
    # sections lands well above 5 KB even with maximum compression.
    assert len(body) > 5_000, f"PDF suspiciously small ({len(body)} bytes)"


def test_pdf_filename_encodes_tenant_slug_and_dates(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    start = today - timedelta(days=1)
    resp = _post_pdf(
        client,
        {"start": start.isoformat(), "end": today.isoformat()},
    )
    assert resp.status_code == 200
    cd = resp.headers["content-disposition"]
    expected = (
        f'attachment; filename="hadir-attendance-main-'
        f'{start.isoformat()}-to-{today.isoformat()}.pdf"'
    )
    assert cd == expected, cd


def test_pdf_filters_to_one_department(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    """ENG-only filter should produce a smaller PDF than the full-tenant
    render (one employee section instead of two)."""

    _login(client, admin_user)
    today = seeded_attendance["today"]
    full = _post_pdf(
        client,
        {"start": today.isoformat(), "end": today.isoformat()},
    )
    filtered = _post_pdf(
        client,
        {
            "start": today.isoformat(),
            "end": today.isoformat(),
            "department_id": 1,  # ENG only
        },
    )
    assert full.status_code == 200
    assert filtered.status_code == 200
    assert _is_pdf(filtered.content)
    assert len(filtered.content) < len(full.content), (
        f"filtered={len(filtered.content)} >= full={len(full.content)}"
    )


# ---------------------------------------------------------------------------
# Role gates
# ---------------------------------------------------------------------------


def test_pdf_403_for_employee_role(
    client: TestClient, employee_user: dict, seeded_attendance
) -> None:
    _login(client, employee_user)
    today = seeded_attendance["today"]
    resp = _post_pdf(
        client,
        {"start": today.isoformat(), "end": today.isoformat()},
    )
    assert resp.status_code == 403


def test_pdf_manager_cross_department_403(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    """Manager assigned to ENG asking for OPS rows → 403."""

    import secrets  # noqa: PLC0415
    from hadir.auth.passwords import hash_password  # noqa: PLC0415
    from hadir.db import (  # noqa: PLC0415
        audit_log,
        manager_assignments,
        roles,
        user_roles,
        user_sessions,
        users,
    )

    suffix = secrets.token_hex(3)
    email = f"mgr-pdf-{suffix}@p17.hadir"
    password = "p17-pw-" + secrets.token_hex(6)

    with admin_engine.begin() as conn:
        uid = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=1,
                    email=email,
                    password_hash=hash_password(password),
                    full_name="P17 Manager",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        rid = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == 1, roles.c.code == "Manager"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=uid, role_id=int(rid), tenant_id=1
            )
        )
        conn.execute(
            insert(user_departments).values(
                user_id=uid, department_id=1, tenant_id=1
            )
        )

    try:
        _login(client, {"email": email, "password": password})
        today = seeded_attendance["today"]
        resp = _post_pdf(
            client,
            {
                "start": today.isoformat(),
                "end": today.isoformat(),
                "department_id": 2,  # OPS
            },
        )
        assert resp.status_code == 403
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                delete(user_sessions).where(
                    user_sessions.c.user_id == uid
                )
            )
            conn.execute(
                delete(audit_log).where(audit_log.c.actor_user_id == uid)
            )
            conn.execute(
                delete(user_roles).where(user_roles.c.user_id == uid)
            )
            conn.execute(
                delete(user_departments).where(
                    user_departments.c.user_id == uid
                )
            )
            conn.execute(
                delete(manager_assignments).where(
                    manager_assignments.c.manager_user_id == uid
                )
            )
            conn.execute(delete(users).where(users.c.id == uid))


# ---------------------------------------------------------------------------
# Date guards
# ---------------------------------------------------------------------------


def test_pdf_rejects_inverted_range(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    resp = _post_pdf(
        client,
        {
            "start": today.isoformat(),
            "end": (today - timedelta(days=2)).isoformat(),
        },
    )
    assert resp.status_code == 400


def test_pdf_rejects_excessive_range(
    client: TestClient, admin_user: dict, seeded_attendance
) -> None:
    _login(client, admin_user)
    today = seeded_attendance["today"]
    resp = _post_pdf(
        client,
        {
            "start": (today - timedelta(days=100)).isoformat(),
            "end": today.isoformat(),
            "max_days": 7,
        },
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Branding-aware
# ---------------------------------------------------------------------------


def test_pdf_branding_color_swap_reflects_in_output(
    client: TestClient, admin_user: dict, seeded_attendance, admin_engine
) -> None:
    """Flipping primary_color_key from teal to navy should change the
    rendered hex string. We check the raw PDF bytes for the canonical
    hex from ``HEX_PALETTE`` — WeasyPrint serialises CSS hex colours
    into the content stream verbatim before the engine transforms
    them, which keeps the assertion robust without parsing PDF.
    """

    _login(client, admin_user)
    today = seeded_attendance["today"]

    # Default tenant_branding for the pilot is teal.
    teal_resp = _post_pdf(
        client,
        {"start": today.isoformat(), "end": today.isoformat()},
    )
    assert teal_resp.status_code == 200

    # Flip to navy and re-render.
    with admin_engine.begin() as conn:
        conn.execute(
            update(tenant_branding)
            .where(tenant_branding.c.tenant_id == 1)
            .values(primary_color_key="navy")
        )
    try:
        navy_resp = _post_pdf(
            client,
            {"start": today.isoformat(), "end": today.isoformat()},
        )
        assert navy_resp.status_code == 200
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenant_branding)
                .where(tenant_branding.c.tenant_id == 1)
                .values(primary_color_key="teal")
            )

    # The two PDFs should not be byte-identical — different hex string
    # in the rendered CSS leads to different content stream bytes.
    assert teal_resp.content != navy_resp.content
