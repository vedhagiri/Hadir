"""Live smoke for P9 — exercises the full event path without a real camera.

Seeds two employees with synthetic enrolled embeddings, calls
``emit_detection_event`` with (a) the known employee's vector and
(b) a random stranger's vector, and prints the resulting
``detection_events`` rows. Cleans up after itself.

Run from inside the backend container:
    python -m scripts.p9_smoke
"""

from __future__ import annotations

import cv2
import numpy as np
from sqlalchemy import delete, insert, select

from hadir.cameras import rtsp as rtsp_io
from hadir.capture.events import emit_detection_event
from hadir.capture.tracker import Bbox
from hadir.db import (
    cameras,
    detection_events,
    employee_photos,
    employees,
    make_admin_engine,
    make_engine,
)
from hadir.identification.embeddings import encrypt_embedding
from hadir.identification.matcher import matcher_cache
from hadir.tenants.scope import TenantScope


def main() -> int:
    admin = make_admin_engine()
    app = make_engine()

    with admin.begin() as conn:
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))

    rng = np.random.default_rng(7)
    alice_vec = rng.standard_normal(512).astype(np.float32)
    alice_vec /= np.linalg.norm(alice_vec)
    bob_vec = rng.standard_normal(512).astype(np.float32)
    bob_vec /= np.linalg.norm(bob_vec)

    with admin.begin() as conn:
        alice = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="ALICE",
                full_name="Alice",
                email=None,
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        bob = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="BOB",
                full_name="Bob",
                email=None,
                department_id=1,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        for emp_id, vec in ((alice, alice_vec), (bob, bob_vec)):
            conn.execute(
                insert(employee_photos).values(
                    tenant_id=1,
                    employee_id=emp_id,
                    angle="front",
                    file_path=f"/dev/null-{emp_id}.jpg",
                    approved_by_user_id=None,
                    approved_at=None,
                    embedding=encrypt_embedding(vec),
                )
            )
        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="LiveSmokeCam",
                location="",
                rtsp_url_encrypted=rtsp_io.encrypt_url("rtsp://fake/99"),
                enabled=False,
            )
            .returning(cameras.c.id)
        ).scalar_one()

    matcher_cache.invalidate_all()

    scope = TenantScope(tenant_id=1)
    frame = np.zeros((200, 200, 3), dtype=np.uint8)

    alice_id = emit_detection_event(
        app,
        scope,
        camera_id=cam_id,
        frame_bgr=frame,
        bbox=Bbox(x=10, y=10, w=80, h=80),
        track_id="t-alice",
        embedding=alice_vec,
    )
    with app.begin() as conn:
        row = conn.execute(
            select(
                detection_events.c.id,
                detection_events.c.employee_id,
                detection_events.c.confidence,
                detection_events.c.embedding,
            ).where(detection_events.c.id == alice_id)
        ).one()
    print(
        f"Alice event id={row.id} employee_id={row.employee_id} "
        f"confidence={row.confidence:.4f}"
    )
    cipher_head = bytes(row.embedding)[:6]
    print(f"  ciphertext starts with gAAAA? {bytes(row.embedding).startswith(b'gAAAA')}")
    print(f"  ciphertext head != plaintext head? {cipher_head != alice_vec.tobytes()[:6]}")

    stranger = rng.standard_normal(512).astype(np.float32)
    stranger /= np.linalg.norm(stranger)
    stranger_id = emit_detection_event(
        app,
        scope,
        camera_id=cam_id,
        frame_bgr=frame,
        bbox=Bbox(x=10, y=10, w=80, h=80),
        track_id="t-stranger",
        embedding=stranger,
    )
    with app.begin() as conn:
        row2 = conn.execute(
            select(
                detection_events.c.employee_id, detection_events.c.confidence
            ).where(detection_events.c.id == stranger_id)
        ).one()
    print(
        f"Stranger event: employee_id={row2.employee_id} "
        f"confidence={row2.confidence}"
    )

    # Cleanup — don't leave smoke data around for subsequent tests / runs.
    with admin.begin() as conn:
        conn.execute(delete(detection_events).where(detection_events.c.tenant_id == 1))
        conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
        conn.execute(delete(cameras).where(cameras.c.tenant_id == 1))
    matcher_cache.invalidate_all()
    print("smoke cleaned up")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
