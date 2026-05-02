"""Pytest coverage for per-tenant branding (v1.0 P4).

Covers the curated-slot rule, the lazy default row, the logo
upload/serve/delete round-trip with magic-byte validation, the
generated CSS body, and the dual-audit on operator-side updates.
"""

from __future__ import annotations

import secrets
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Engine

from maugood.auth.passwords import hash_password
from maugood.branding import css as branding_css
from maugood.branding.constants import BRAND_PALETTE, FONT_OPTIONS
from maugood.db import (
    audit_log,
    mts_staff,
    super_admin_audit,
    super_admin_sessions,
    tenant_branding,
    tenant_context,
)


# Tiny PNG: 1×1 transparent. Magic bytes match logo.write_logo's PNG check.
_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c63600100000005000100000000490000000049454e"
    "44ae426082"
)
_TINY_SVG = b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>"


@pytest.fixture(autouse=True)
def _reset_branding_cache() -> Iterator[None]:
    branding_css.clear_cache()
    yield
    branding_css.clear_cache()


@pytest.fixture
def super_admin_user(admin_engine: Engine) -> Iterator[dict]:
    """Create an MTS staff user, yield credentials, clean up.

    Cookie-flow tests share this; mirrors the fixture in
    test_super_admin.py but kept local so the two files stay
    independent.
    """

    email = f"sa-brand-{secrets.token_hex(4)}@super.maugood"
    password = "super-pw-" + secrets.token_hex(6)
    password_hash = hash_password(password)
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            staff_id = conn.execute(
                insert(mts_staff)
                .values(
                    email=email,
                    password_hash=password_hash,
                    full_name="Test SA Branding",
                    is_active=True,
                )
                .returning(mts_staff.c.id)
            ).scalar_one()
    try:
        yield {"id": int(staff_id), "email": email, "password": password}
    finally:
        with tenant_context("public"):
            with admin_engine.begin() as conn:
                conn.execute(
                    delete(super_admin_audit).where(
                        super_admin_audit.c.super_admin_user_id == staff_id
                    )
                )
                conn.execute(
                    delete(super_admin_sessions).where(
                        super_admin_sessions.c.mts_staff_id == staff_id
                    )
                )
                conn.execute(delete(mts_staff).where(mts_staff.c.id == staff_id))


@pytest.fixture
def reset_branding_row(admin_engine: Engine) -> Iterator[None]:
    """Restore tenant_id=1 branding to defaults around each test."""

    with admin_engine.begin() as conn:
        conn.execute(
            tenant_branding.update()
            .where(tenant_branding.c.tenant_id == 1)
            .values(primary_color_key="teal", font_key="inter", logo_path=None)
        )
    yield
    with admin_engine.begin() as conn:
        conn.execute(
            tenant_branding.update()
            .where(tenant_branding.c.tenant_id == 1)
            .values(primary_color_key="teal", font_key="inter", logo_path=None)
        )


def _login_admin(client: TestClient, admin_user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user["email"], "password": admin_user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _login_super_admin(client: TestClient, super_admin_user: dict) -> None:
    resp = client.post(
        "/api/super-admin/login",
        json={"email": super_admin_user["email"], "password": super_admin_user["password"]},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Tenant-side
# ---------------------------------------------------------------------------


def test_default_branding_row_returned_on_first_read(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, admin_user)
    resp = client.get("/api/branding")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["primary_color_key"] == "teal"
    assert body["font_key"] == "inter"
    assert body["has_logo"] is False
    assert body["tenant_id"] == 1


def test_options_endpoint_lists_curated_only(
    client: TestClient, admin_user: dict
) -> None:
    _login_admin(client, admin_user)
    resp = client.get("/api/branding/options")
    assert resp.status_code == 200
    body = resp.json()
    keys = {p["key"] for p in body["palette"]}
    assert keys == set(BRAND_PALETTE.keys())
    fonts = {f["key"] for f in body["fonts"]}
    assert fonts == set(FONT_OPTIONS.keys())


def test_patch_validates_against_palette(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, admin_user)

    # Free-form hex must be rejected.
    bad = client.patch("/api/branding", json={"primary_color_key": "#ff0000"})
    assert bad.status_code == 400, bad.text

    # Curated key passes and persists.
    ok = client.patch("/api/branding", json={"primary_color_key": "navy"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["primary_color_key"] == "navy"


def test_patch_validates_against_fonts(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, admin_user)

    bad = client.patch("/api/branding", json={"font_key": "comic-sans"})
    assert bad.status_code == 400

    ok = client.patch("/api/branding", json={"font_key": "lato"})
    assert ok.status_code == 200
    assert ok.json()["font_key"] == "lato"


def test_patch_display_name_updates_public_tenants_row(
    client: TestClient,
    admin_engine: Engine,
    admin_user: dict,
    reset_branding_row: None,
) -> None:
    """Branding patch is the natural surface for the corporate
    display name. The value lives in ``public.tenants.name`` and
    threads through ``MeResponse.tenant_name`` so the sidebar brand
    row picks it up on the next /me refresh."""

    from sqlalchemy import select, update  # noqa: PLC0415

    from maugood.db import tenants  # noqa: PLC0415
    from tests.conftest import TENANT_ID  # noqa: PLC0415

    _login_admin(client, admin_user)

    # Snapshot the current name so we can restore + flip it back.
    with admin_engine.begin() as conn:
        before = conn.execute(
            select(tenants.c.name).where(tenants.c.id == TENANT_ID)
        ).scalar_one()

    try:
        # Empty / blank string → 400, no DB write.
        empty = client.patch("/api/branding", json={"display_name": "   "})
        assert empty.status_code == 400, empty.text

        # Non-empty → 200, response carries the trimmed value, DB
        # row reflects it.
        ok = client.patch(
            "/api/branding", json={"display_name": "  ACME Corporation  "}
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["display_name"] == "ACME Corporation"

        # /api/auth/me threads the value through tenant_name.
        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["tenant_name"] == "ACME Corporation"

        with admin_engine.begin() as conn:
            on_disk = conn.execute(
                select(tenants.c.name).where(tenants.c.id == TENANT_ID)
            ).scalar_one()
        assert on_disk == "ACME Corporation"
    finally:
        with admin_engine.begin() as conn:
            conn.execute(
                update(tenants).where(tenants.c.id == TENANT_ID).values(
                    name=before
                )
            )


def test_me_carries_brand_logo_meta_after_upload(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    """``MeResponse.has_brand_logo`` flips True after an upload and
    ``brand_logo_version`` carries the row's updated_at so the
    frontend cache-busts the served logo URL."""

    _login_admin(client, admin_user)

    me_before = client.get("/api/auth/me").json()
    assert me_before["has_brand_logo"] is False
    assert me_before["brand_logo_version"] in (None, "")

    upload = client.post(
        "/api/branding/logo",
        files={"logo": ("logo.png", _TINY_PNG, "image/png")},
    )
    assert upload.status_code == 200, upload.text

    me_after = client.get("/api/auth/me").json()
    assert me_after["has_brand_logo"] is True
    assert isinstance(me_after["brand_logo_version"], str)
    assert me_after["brand_logo_version"]  # non-empty ISO timestamp


def test_patch_writes_audit_row(
    client: TestClient,
    admin_engine: Engine,
    admin_user: dict,
    reset_branding_row: None,
) -> None:
    _login_admin(client, admin_user)
    resp = client.patch("/api/branding", json={"primary_color_key": "navy"})
    assert resp.status_code == 200
    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(audit_log.c.action, audit_log.c.before, audit_log.c.after)
            .where(
                audit_log.c.action == "branding.updated",
                audit_log.c.actor_user_id == admin_user["id"],
            )
            .order_by(audit_log.c.id.desc())
        ).all()
    assert rows, "expected at least one branding.updated audit row"
    after = rows[0].after or {}
    assert after.get("primary_color_key") == "navy"


def test_employee_role_cannot_patch_branding(
    client: TestClient, employee_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, employee_user)
    resp = client.patch("/api/branding", json={"primary_color_key": "navy"})
    assert resp.status_code == 403, resp.text


def test_branding_css_body_carries_overrides(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, admin_user)
    client.patch("/api/branding", json={"primary_color_key": "navy", "font_key": "lato"})

    resp = client.get("/api/branding.css")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/css")
    body = resp.text
    assert "--accent:" in body
    assert "oklch(0.42 0.09 250)" in body  # navy
    assert "'Lato'" in body


def test_logo_upload_round_trip_and_validations(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    _login_admin(client, admin_user)

    # Reject a fake-PNG header on a non-PNG body.
    fake = client.post(
        "/api/branding/logo",
        files={"logo": ("logo.png", b"\x00\x00not-a-png", "image/png")},
    )
    assert fake.status_code == 400

    # Reject oversized (>2 MB) PNGs. Trailing zeros are enough to
    # blow past the size cap before any image-decoder ever sees the
    # payload — the magic-byte check is fine since the file starts
    # with a real PNG header.
    huge = _TINY_PNG + b"\x00" * (2 * 1024 * 1024)
    big = client.post(
        "/api/branding/logo",
        files={"logo": ("logo.png", huge, "image/png")},
    )
    assert big.status_code == 400

    # Accept a tiny real PNG.
    ok = client.post(
        "/api/branding/logo",
        files={"logo": ("logo.png", _TINY_PNG, "image/png")},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["has_logo"] is True

    # GET returns the bytes back.
    served = client.get("/api/branding/logo")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/png"
    assert served.content == _TINY_PNG

    # Replace with SVG.
    ok2 = client.post(
        "/api/branding/logo",
        files={"logo": ("logo.svg", _TINY_SVG, "image/svg+xml")},
    )
    assert ok2.status_code == 200
    served_svg = client.get("/api/branding/logo")
    assert served_svg.headers["content-type"] == "image/svg+xml"
    assert served_svg.content == _TINY_SVG

    # Delete clears the row + 404s on the GET.
    deleted = client.delete("/api/branding/logo")
    assert deleted.status_code == 204
    after = client.get("/api/branding")
    assert after.json()["has_logo"] is False
    gone = client.get("/api/branding/logo")
    assert gone.status_code == 404


def test_oversized_png_is_resized_to_max_dimension(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    """A 1024×1024 PNG upload must be resized to ≤ 512 px on the
    longest side before storage. Smaller PNGs round-trip byte-for-byte
    (covered by the round-trip test above)."""

    from io import BytesIO  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    _login_admin(client, admin_user)

    # Build a real 1024×1024 RGBA PNG. Magic bytes pass the validator;
    # Pillow can decode it, so the resize path runs.
    img = Image.new("RGBA", (1024, 1024), color=(70, 100, 220, 255))
    buf = BytesIO()
    img.save(buf, format="PNG")
    big_png = buf.getvalue()
    assert len(big_png) > 0

    resp = client.post(
        "/api/branding/logo",
        files={"logo": ("big.png", big_png, "image/png")},
    )
    assert resp.status_code == 200, resp.text

    # The bytes served back should decode to a PNG whose longest side
    # is ≤ 512 px — the resize cap. Aspect ratio preserved (1:1 in,
    # 1:1 out).
    served = client.get("/api/branding/logo")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/png"
    out = Image.open(BytesIO(served.content))
    assert max(out.size) <= 512, out.size
    assert out.size[0] == out.size[1], out.size  # 1:1 preserved
    # Re-encode + downsize must produce smaller bytes than the source.
    assert len(served.content) < len(big_png)


def test_small_png_passes_through_byte_for_byte(
    client: TestClient, admin_user: dict, reset_branding_row: None
) -> None:
    """A PNG already within the dimension cap must NOT be re-encoded —
    the served bytes equal the uploaded bytes. Operators who tuned a
    256×256 logo for sharpness shouldn't lose that to a needless
    Pillow round-trip."""

    from io import BytesIO  # noqa: PLC0415

    from PIL import Image  # noqa: PLC0415

    _login_admin(client, admin_user)

    img = Image.new("RGBA", (256, 256), color=(0, 0, 0, 0))
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    small_png = buf.getvalue()

    resp = client.post(
        "/api/branding/logo",
        files={"logo": ("small.png", small_png, "image/png")},
    )
    assert resp.status_code == 200, resp.text

    served = client.get("/api/branding/logo")
    assert served.status_code == 200
    assert served.content == small_png  # byte-for-byte


# ---------------------------------------------------------------------------
# Super-admin operator surface
# ---------------------------------------------------------------------------


def test_super_admin_patch_dual_audits(
    client: TestClient,
    admin_engine: Engine,
    super_admin_user: dict,
    reset_branding_row: None,
) -> None:
    _login_super_admin(client, super_admin_user)
    resp = client.patch(
        "/api/super-admin/tenants/1/branding",
        json={"primary_color_key": "navy", "font_key": "lato"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["primary_color_key"] == "navy"
    assert body["font_key"] == "lato"

    # Tenant-side audit row carries the impersonation marker.
    with admin_engine.begin() as conn:
        tenant_rows = conn.execute(
            select(audit_log.c.after).where(
                audit_log.c.action == "branding.updated",
                audit_log.c.entity_id == "1",
            )
            .order_by(audit_log.c.id.desc())
        ).all()
    assert tenant_rows, "expected tenant audit_log row"
    assert (
        tenant_rows[0].after.get("impersonated_by_super_admin_user_id")
        == super_admin_user["id"]
    )

    # Operator-side row.
    with tenant_context("public"):
        with admin_engine.begin() as conn:
            sa_rows = conn.execute(
                select(super_admin_audit.c.action, super_admin_audit.c.tenant_id)
                .where(
                    super_admin_audit.c.super_admin_user_id == super_admin_user["id"],
                    super_admin_audit.c.action == "branding.updated",
                )
                .order_by(super_admin_audit.c.id.desc())
            ).all()
    assert sa_rows, "expected operator audit row"
    assert sa_rows[0].tenant_id == 1
