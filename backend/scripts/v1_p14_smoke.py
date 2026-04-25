"""End-to-end smoke for v1.0 P14 — request submission UI.

Provisions an Employee on the ``main`` tenant, submits an exception
request, attaches a real PNG, lists their requests + attachments
(matching what the frontend renders), then cleans up.

Run inside the backend container:

    docker compose exec -e HADIR_SMOKE_PASSWORD='…' backend \\
        python -m scripts.v1_p14_smoke
"""

from __future__ import annotations

import os
import secrets
import sys
from datetime import date, timedelta
from pathlib import Path

import httpx
from sqlalchemy import delete, insert, select

from hadir.auth.passwords import hash_password
from hadir.db import (
    audit_log,
    departments,
    employees,
    make_admin_engine,
    request_attachments,
    requests as requests_table,
    roles,
    user_roles,
    user_sessions,
    users,
)


BASE = "http://localhost:8000"
TENANT_ID = 1

_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6300010000000500010d0a2db40000000049454e44ae42"
    "6082"
)


def _provision_employee(engine, *, email: str, password: str) -> tuple[int, int]:
    pwh = hash_password(password)
    with engine.begin() as conn:
        uid = int(
            conn.execute(
                insert(users)
                .values(
                    tenant_id=TENANT_ID,
                    email=email,
                    password_hash=pwh,
                    full_name="P14 Smoke",
                    is_active=True,
                )
                .returning(users.c.id)
            ).scalar_one()
        )
        rid = conn.execute(
            select(roles.c.id).where(
                roles.c.tenant_id == TENANT_ID, roles.c.code == "Employee"
            )
        ).scalar_one()
        conn.execute(
            insert(user_roles).values(
                user_id=uid, role_id=int(rid), tenant_id=TENANT_ID
            )
        )
        eng_dept = int(
            conn.execute(
                select(departments.c.id).where(
                    departments.c.tenant_id == TENANT_ID,
                    departments.c.code == "ENG",
                )
            ).scalar_one()
        )
        emp_id = int(
            conn.execute(
                insert(employees)
                .values(
                    tenant_id=TENANT_ID,
                    employee_code=f"P14-{secrets.token_hex(2)}",
                    full_name="P14 Smoke",
                    email=email,
                    department_id=eng_dept,
                )
                .returning(employees.c.id)
            ).scalar_one()
        )
    return uid, emp_id


def _cleanup(engine, user_id: int, emp_id: int) -> None:
    with engine.begin() as conn:
        # Capture attachment paths so we can delete the encrypted blobs.
        paths = [
            str(p)
            for p in conn.execute(
                select(request_attachments.c.file_path).where(
                    request_attachments.c.tenant_id == TENANT_ID
                )
            ).scalars()
        ]
        conn.execute(
            delete(request_attachments).where(
                request_attachments.c.tenant_id == TENANT_ID
            )
        )
        conn.execute(
            delete(requests_table).where(
                requests_table.c.employee_id == emp_id
            )
        )
        conn.execute(
            delete(audit_log).where(audit_log.c.actor_user_id == user_id)
        )
        conn.execute(
            delete(audit_log).where(audit_log.c.entity_type == "request")
        )
        conn.execute(
            delete(user_sessions).where(user_sessions.c.user_id == user_id)
        )
        conn.execute(
            delete(user_roles).where(user_roles.c.user_id == user_id)
        )
        conn.execute(delete(employees).where(employees.c.id == emp_id))
        conn.execute(delete(users).where(users.c.id == user_id))
    for p in paths:
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass


def main() -> int:
    if not os.environ.get("HADIR_SMOKE_PASSWORD"):
        print("[p14] set HADIR_SMOKE_PASSWORD", file=sys.stderr)
        return 1

    suffix = secrets.token_hex(4)
    employee_email = f"emp-{suffix}@p14.hadir"
    pwd = "P14Smoke!" + secrets.token_hex(4)

    admin_engine = make_admin_engine()
    user_id, emp_id = _provision_employee(
        admin_engine, email=employee_email, password=pwd
    )

    rc = 0
    try:
        with httpx.Client(base_url=BASE, follow_redirects=False, timeout=20) as c:
            login = c.post(
                "/api/auth/login",
                json={"email": employee_email, "password": pwd},
            )
            login.raise_for_status()
            print(f"[p14] login OK as {employee_email}")

            cfg = c.get("/api/requests/attachment-config")
            cfg.raise_for_status()
            print(
                f"[p14] attachment config: max_mb={cfg.json()['max_mb']} "
                f"types={len(cfg.json()['accepted_mime_types'])}"
            )

            cats = c.get("/api/request-reason-categories?request_type=exception")
            cats.raise_for_status()
            print(
                f"[p14] {len(cats.json())} exception reason categories "
                f"({', '.join(c['code'] for c in cats.json())})"
            )

            target_date = date.today() + timedelta(days=2)
            create = c.post(
                "/api/requests",
                json={
                    "type": "exception",
                    "reason_category": "Doctor",
                    "reason_text": "Annual checkup",
                    "target_date_start": target_date.isoformat(),
                },
            )
            create.raise_for_status()
            req = create.json()
            req_id = req["id"]
            print(
                f"[p14] submitted request id={req_id} status={req['status']} "
                f"manager_user_id={req['manager_user_id']}"
            )

            upload = c.post(
                f"/api/requests/{req_id}/attachments",
                files={"file": ("checkup.png", _PNG_BYTES, "image/png")},
            )
            upload.raise_for_status()
            att = upload.json()
            print(
                f"[p14] attached id={att['id']} "
                f"original={att['original_filename']!r} "
                f"size={att['size_bytes']}B "
                f"content_type={att['content_type']}"
            )

            mine = c.get("/api/requests")
            mine.raise_for_status()
            visible_ids = {row["id"] for row in mine.json()}
            assert req_id in visible_ids, mine.text
            print(f"[p14] my-requests list contains request id={req_id}")

            attlist = c.get(f"/api/requests/{req_id}/attachments")
            attlist.raise_for_status()
            assert any(a["id"] == att["id"] for a in attlist.json())
            print(f"[p14] attachment list returns id={att['id']}")

            # Download round-trips the original bytes.
            download = c.get(
                f"/api/requests/{req_id}/attachments/{att['id']}/download"
            )
            download.raise_for_status()
            assert download.content == _PNG_BYTES
            print(
                f"[p14] download returns {len(download.content)}B identical to "
                f"original PNG"
            )

            # Refuse a fake .pdf with the wrong magic bytes.
            evil = c.post(
                f"/api/requests/{req_id}/attachments",
                files={
                    "file": (
                        "evil.pdf",
                        b"this is not a pdf" * 4,
                        "application/pdf",
                    )
                },
            )
            assert evil.status_code == 400, evil.text
            print(f"[p14] fake .pdf rejected: {evil.json()['detail']!r}")

        print("[p14] OK")
    except (AssertionError, httpx.HTTPStatusError) as exc:
        print(f"[p14] FAIL — {exc}", file=sys.stderr)
        rc = 1
    finally:
        _cleanup(admin_engine, user_id, emp_id)
        admin_engine.dispose()
        print("[p14] cleanup complete")

    return rc


if __name__ == "__main__":
    sys.exit(main())
