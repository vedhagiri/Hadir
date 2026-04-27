"""Tests for P6: photo ingestion, Fernet-at-rest, rejection rules."""

from __future__ import annotations

import shutil
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from hadir.config import get_settings


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def _seed_three(client: TestClient) -> None:
    """Import OM0098/OM0099/OM0100 so photo tests have employees to link to."""

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(["employee_code", "full_name", "email", "department_code"])
    ws.append(["OM0098", "Fatima Al-Kindi", "fatima@x", "OPS"])
    ws.append(["OM0099", "Layla Al-Busaidi", "layla@x", "ADM"])
    ws.append(["OM0100", "Nadia Al-Hinai", "nadia@x", "ENG"])
    buf = BytesIO()
    wb.save(buf)
    resp = client.post(
        "/api/employees/import",
        files={
            "file": (
                "seed.xlsx",
                buf.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture
def clean_faces_dir() -> None:
    """Wipe the test tenant's faces tree for determinism.

    Important: scoped to ``/data/faces/{TEST_TENANT_ID}/`` and
    ``/data/faces/captures/{TEST_TENANT_ID}/`` rather than the whole
    ``/data/faces`` tree. Earlier this fixture rmtree'd the entire
    root, which on a shared dev volume also deleted prod tenants'
    encrypted photos + capture crops every time anyone ran
    ``pytest -q``. Camera Logs broke for the prod tenant because
    ``detection_events`` rows survived (different schema) but the
    files they referenced were gone. Future regression: never
    broaden the rmtree target above the per-tenant subtree.
    """

    test_tenant_id = get_settings().default_tenant_id
    root = Path(get_settings().faces_storage_path)
    targets = [root / str(test_tenant_id), root / "captures" / str(test_tenant_id)]
    for target in targets:
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)


# A minimal valid JPEG — a 1x1 image. Good enough for a smoke test; P9
# replaces this with InsightFace embeddings on real crops.
_JPEG_BYTES = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606"
    "070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d"
    "1a1c1c20242e2720222c231c1c2837292c30313434341f27393d3832"
    "3c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232"
    "3232323232323232323232323232323232323232323232323232323232"
    "323232323232323232323232323232323232ffc00011080001000103012200021101031101"
    "ffc4001f0000010501010101010100000000000000000102030405060708090a0b"
    "ffc400b5100002010303020403050504040000017d010203000411051221"
    "31410613516107227114328191a1082342b1c11552d1f02433627282090a"
    "161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"
    "ffc4001f0100030101010101010101010000000000000102030405060708090a0b"
    "ffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa"
    "ffda000c03010002110311003f00fbd3ffd9"
)


# ---------------------------------------------------------------------------
# Bulk folder-dump ingest
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_bulk_ingest_honours_filename_convention(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _seed_three(client)

    files = [
        ("files", ("OM0098.jpg", _JPEG_BYTES, "image/jpeg")),        # unlabelled → front
        ("files", ("OM0098_left.jpg", _JPEG_BYTES, "image/jpeg")),
        ("files", ("OM0099_front.jpg", _JPEG_BYTES, "image/jpeg")),
        ("files", ("OM0099_right.jpg", _JPEG_BYTES, "image/jpeg")),
        ("files", ("OM9999_front.jpg", _JPEG_BYTES, "image/jpeg")),  # unknown employee
        # `!@#$.jpg` is malformed — the filename parser rejects it outright
        # before we even try to look up an employee.
        ("files", ("!@#$.jpg", _JPEG_BYTES, "image/jpeg")),
    ]
    resp = client.post("/api/employees/photos/bulk", files=files)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert len(body["accepted"]) == 4
    angles_by_code: dict[str, list[str]] = {}
    for a in body["accepted"]:
        angles_by_code.setdefault(a["employee_code"], []).append(a["angle"])
    assert sorted(angles_by_code["OM0098"]) == ["front", "left"]
    assert sorted(angles_by_code["OM0099"]) == ["front", "right"]

    assert len(body["rejected"]) == 2
    reasons = [r["reason"] for r in body["rejected"]]
    assert any("unknown employee_code" in r for r in reasons)
    assert any("filename does not match" in r for r in reasons)


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_unknown_employee_does_not_auto_create(
    client: TestClient, admin_user: dict, admin_engine
) -> None:
    _login(client, admin_user)
    _seed_three(client)

    before = {e["employee_code"] for e in client.get("/api/employees").json()["items"]}

    files = [("files", ("OM9999_front.jpg", _JPEG_BYTES, "image/jpeg"))]
    resp = client.post("/api/employees/photos/bulk", files=files)
    assert resp.status_code == 200
    assert len(resp.json()["rejected"]) == 1

    after = {e["employee_code"] for e in client.get("/api/employees").json()["items"]}
    assert before == after  # no new employee row materialised


# ---------------------------------------------------------------------------
# File bytes are encrypted at rest
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_on_disk_bytes_are_fernet_encrypted_not_jpeg(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _seed_three(client)

    files = [("files", ("OM0098_front.jpg", _JPEG_BYTES, "image/jpeg"))]
    resp = client.post("/api/employees/photos/bulk", files=files)
    assert resp.status_code == 200
    accepted = resp.json()["accepted"]
    assert len(accepted) == 1

    # Walk the storage dir and check the raw bytes on disk don't start
    # with the JPEG SOI marker (ff d8 ff).
    root = Path(get_settings().faces_storage_path)
    jpgs = list(root.rglob("*.jpg"))
    assert jpgs, "expected at least one file on disk"
    for path in jpgs:
        head = path.read_bytes()[:3]
        assert head != b"\xff\xd8\xff", f"{path} looks like plaintext JPEG — not encrypted!"


# ---------------------------------------------------------------------------
# Image fetch decrypts back to the original bytes
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_image_fetch_decrypts_to_original_bytes(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _seed_three(client)

    files = [("files", ("OM0098_front.jpg", _JPEG_BYTES, "image/jpeg"))]
    resp = client.post("/api/employees/photos/bulk", files=files)
    accepted = resp.json()["accepted"][0]
    photo_id = accepted["photo_id"]

    # Resolve employee id through search.
    emp_id = next(
        e["id"]
        for e in client.get("/api/employees?q=OM0098").json()["items"]
    )

    fetched = client.get(f"/api/employees/{emp_id}/photos/{photo_id}/image")
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/jpeg"
    assert fetched.content == _JPEG_BYTES


# ---------------------------------------------------------------------------
# Drawer-style upload (single angle for multiple files)
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_drawer_upload_and_photo_count_updates(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    _seed_three(client)

    emp_id = next(
        e["id"]
        for e in client.get("/api/employees?q=OM0100").json()["items"]
    )

    # Photo count starts at 0.
    detail = client.get(f"/api/employees/{emp_id}").json()
    assert detail["photo_count"] == 0

    files = [
        ("files", ("a.jpg", _JPEG_BYTES, "image/jpeg")),
        ("files", ("b.jpg", _JPEG_BYTES, "image/jpeg")),
    ]
    resp = client.post(
        f"/api/employees/{emp_id}/photos", files=files, data={"angle": "left"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["accepted"]) == 2
    assert all(a["angle"] == "left" for a in body["accepted"])

    # photo_count now 2 in the employee list + detail.
    detail2 = client.get(f"/api/employees/{emp_id}").json()
    assert detail2["photo_count"] == 2


# ---------------------------------------------------------------------------
# 403 — Employee role forbidden from ingesting
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("clean_employees", "clean_faces_dir")
def test_employee_role_cannot_ingest_photos(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    files = [("files", ("OM0098.jpg", _JPEG_BYTES, "image/jpeg"))]
    assert client.post("/api/employees/photos/bulk", files=files).status_code == 403
