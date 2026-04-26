"""Tests for P28.5a Live Capture: per-worker preview, MJPEG endpoint,
WebSocket auth + heartbeat, audit, tenant-scoped get_preview, and the
defence-in-depth cross-tenant 404 case.

The frame_buffer.py singleton is gone — frames live on the per-worker
``_latest_jpeg`` slot inside ``CaptureWorker``. Tests inject frames by
constructing a tiny ``CaptureWorker``-like stub and registering it
directly into the manager's ``_workers`` dict, or by planting bytes
on a dummy worker and asserting the manager forwards through.

Tenant isolation continues to be enforced by the P5 suite plus the
specific cross-tenant 404 case here.
"""

from __future__ import annotations

import time
from typing import Iterator, Optional

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import insert
from sqlalchemy.engine import Engine

from hadir.capture.manager import CaptureManager, capture_manager
from hadir.db import cameras
from tests.conftest import audit_rows_for_user


# ---------------------------------------------------------------------------
# Fake worker for direct injection into the manager's workers dict
# ---------------------------------------------------------------------------


class _FakeWorker:
    """Minimal CaptureWorker stand-in: holds a JPEG + timestamp.

    Implements just the slice the manager and router consume:
    ``get_latest_jpeg``, ``is_preview_fresh``, ``get_stats``,
    ``is_alive``, ``stop``. Tests construct one, install it on
    ``capture_manager._workers[(tenant_id, camera_id)]`` for the
    duration of the test, and assert end-to-end MJPEG flow.
    """

    def __init__(self, *, camera_id: int, jpeg: Optional[bytes] = None) -> None:
        self.camera_id = camera_id
        self._jpeg = jpeg
        self._ts = time.time() if jpeg is not None else 0.0
        self._stopped = False

    def set_jpeg(self, jpeg: bytes) -> None:
        self._jpeg = jpeg
        self._ts = time.time()

    def get_latest_jpeg(self):  # type: ignore[no-untyped-def]
        if self._jpeg is None:
            return None
        return self._jpeg, self._ts

    def is_preview_fresh(self, *, max_age_s: float = 5.0) -> bool:
        if self._jpeg is None:
            return False
        return (time.time() - self._ts) <= max_age_s

    def get_stats(self) -> dict:
        return {
            "fps_reader": 12.0,
            "fps_analyzer": 4.5,
            "active_tracks": 0,
            "motion_skipped": 0,
            "status": "streaming",
            "last_error": None,
        }

    def is_alive(self) -> bool:
        return not self._stopped

    def stop(self, timeout: float = 5.0) -> None:
        self._stopped = True


@pytest.fixture
def install_fake_worker():
    """Yield a function that installs a _FakeWorker into the singleton
    capture_manager for the test, and tears it down after.
    """

    installed: list[tuple[int, int]] = []

    def _install(*, tenant_id: int, camera_id: int, jpeg: Optional[bytes] = None) -> _FakeWorker:
        worker = _FakeWorker(camera_id=camera_id, jpeg=jpeg)
        with capture_manager._lock:  # noqa: SLF001
            capture_manager._workers[(tenant_id, camera_id)] = worker  # type: ignore[assignment]
        installed.append((tenant_id, camera_id))
        return worker

    yield _install

    with capture_manager._lock:  # noqa: SLF001
        for key in installed:
            capture_manager._workers.pop(key, None)


# ---------------------------------------------------------------------------
# CaptureManager — multi-tenant get_preview
# ---------------------------------------------------------------------------


def test_manager_get_preview_returns_workers_jpeg() -> None:
    mgr = CaptureManager()
    worker = _FakeWorker(camera_id=7, jpeg=b"jpeg-data")
    with mgr._lock:  # noqa: SLF001
        mgr._workers[(1, 7)] = worker  # type: ignore[assignment]

    got = mgr.get_preview(1, 7)
    assert got is not None
    jpg, _ts = got
    assert jpg == b"jpeg-data"


def test_manager_get_preview_is_tenant_scoped() -> None:
    """Cross-tenant guess must return None even with planted JPEG."""

    mgr = CaptureManager()
    worker = _FakeWorker(camera_id=7, jpeg=b"private-jpeg")
    with mgr._lock:  # noqa: SLF001
        mgr._workers[(1, 7)] = worker  # type: ignore[assignment]

    # Wrong tenant for this camera_id — manager refuses to serve.
    assert mgr.get_preview(tenant_id=2, camera_id=7) is None
    # Wrong camera_id under the correct tenant — likewise.
    assert mgr.get_preview(tenant_id=1, camera_id=8) is None
    # Correct pair — yields bytes.
    got = mgr.get_preview(tenant_id=1, camera_id=7)
    assert got is not None and got[0] == b"private-jpeg"


def test_manager_get_preview_returns_none_when_jpeg_missing() -> None:
    mgr = CaptureManager()
    worker = _FakeWorker(camera_id=7, jpeg=None)
    with mgr._lock:  # noqa: SLF001
        mgr._workers[(1, 7)] = worker  # type: ignore[assignment]
    assert mgr.get_preview(1, 7) is None


def test_manager_active_camera_ids_supports_tenant_scope() -> None:
    mgr = CaptureManager()
    with mgr._lock:  # noqa: SLF001
        mgr._workers[(1, 7)] = _FakeWorker(camera_id=7, jpeg=b"x")  # type: ignore[assignment]
        mgr._workers[(2, 9)] = _FakeWorker(camera_id=9, jpeg=b"y")  # type: ignore[assignment]
    assert sorted(mgr.active_camera_ids()) == [7, 9]
    assert mgr.active_camera_ids(tenant_id=1) == [7]
    assert mgr.active_camera_ids(tenant_id=2) == [9]


# ---------------------------------------------------------------------------
# Endpoint fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def seeded_camera(admin_engine: Engine) -> Iterator[dict]:
    """Insert a tenant-1 camera; clean up the row after."""

    from hadir.cameras import rtsp as rtsp_io  # noqa: PLC0415

    with admin_engine.begin() as conn:
        cam_id = conn.execute(
            insert(cameras)
            .values(
                tenant_id=1,
                name="P28.5a test camera",
                location="test rack",
                rtsp_url_encrypted=rtsp_io.encrypt_url(
                    "rtsp://test:test@127.0.0.1:1/stream"
                ),
                worker_enabled=False,
                display_enabled=True,
            )
            .returning(cameras.c.id)
        ).scalar_one()
    try:
        yield {"id": int(cam_id)}
    finally:
        with admin_engine.begin() as conn:
            conn.execute(cameras.delete().where(cameras.c.id == cam_id))


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# MJPEG endpoint
# ---------------------------------------------------------------------------


def test_mjpg_requires_auth(
    client: TestClient, seeded_camera: dict
) -> None:
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/live.mjpg")
    assert resp.status_code == 401


def test_mjpg_forbids_non_admin(
    client: TestClient, employee_user: dict, seeded_camera: dict
) -> None:
    _login(client, employee_user)
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/live.mjpg")
    assert resp.status_code == 403


def test_mjpg_returns_404_on_unknown_camera(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    # 999_999 won't exist in any tenant.
    resp = client.get("/api/cameras/999999/live.mjpg")
    assert resp.status_code == 404


def test_mjpg_cross_tenant_returns_404(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    install_fake_worker,
) -> None:
    """A camera that exists in tenant 2 but not tenant 1 must 404 for
    a tenant-1 admin even with a fresh JPEG planted in the manager.
    Defence in depth on top of the WHERE tenant_id = … filter.
    """

    from hadir.cameras import rtsp as rtsp_io  # noqa: PLC0415

    # Plant a worker for tenant 99, camera 1234 (wrong tenant). Plant
    # the bytes too, to prove the bytes never leak even when present.
    install_fake_worker(tenant_id=99, camera_id=1234, jpeg=b"\xff\xd8\xff\xe0xx\xff\xd9")

    _login(client, admin_user)
    # Admin is on tenant 1; the row doesn't exist there → router 404s.
    resp = client.get("/api/cameras/1234/live.mjpg")
    assert resp.status_code == 404


def test_mjpg_streams_frames_when_worker_serves_jpeg(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded_camera: dict,
    install_fake_worker,
) -> None:
    """Plant a worker via the manager + verify the multipart wrapper +
    a full frame body come through. Closes after the body is read so
    the audit unsubscribe row writes."""

    install_fake_worker(
        tenant_id=1,
        camera_id=seeded_camera["id"],
        jpeg=b"\xff\xd8\xff\xe0FAKE-JPEG\xff\xd9",
    )
    _login(client, admin_user)
    fake_jpeg = b"\xff\xd8\xff\xe0FAKE-JPEG\xff\xd9"
    with client.stream(
        "GET", f"/api/cameras/{seeded_camera['id']}/live.mjpg"
    ) as resp:
        assert resp.status_code == 200
        assert "multipart/x-mixed-replace" in resp.headers["content-type"]
        chunks = []
        total = 0
        for chunk in resp.iter_bytes():
            chunks.append(chunk)
            total += len(chunk)
            if total >= len(fake_jpeg) + 64:
                break
        body = b"".join(chunks)
        assert b"--frame" in body
        assert b"Content-Type: image/jpeg" in body
        assert fake_jpeg in body


def test_mjpg_audits_subscribe_and_unsubscribe_only(
    client: TestClient,
    admin_user: dict,
    admin_engine: Engine,
    seeded_camera: dict,
    install_fake_worker,
) -> None:
    """The audit log must show one subscribe + one unsubscribe row per
    stream — never per frame, regardless of how many frames were sent.
    """

    install_fake_worker(
        tenant_id=1,
        camera_id=seeded_camera["id"],
        jpeg=b"\xff\xd8\xff\xe0xx\xff\xd9",
    )
    _login(client, admin_user)
    with client.stream(
        "GET", f"/api/cameras/{seeded_camera['id']}/live.mjpg"
    ) as resp:
        assert resp.status_code == 200
        # Read several chunks to confirm we'd be dropping per-frame
        # audits if the implementation regressed.
        chunks_read = 0
        for _ in resp.iter_bytes(chunk_size=512):
            chunks_read += 1
            if chunks_read >= 4:
                break

    # Allow the generator's finally to run.
    time.sleep(0.2)
    rows = audit_rows_for_user(admin_engine, admin_user["id"])
    actions = [r["action"] for r in rows]
    sub_count = actions.count("live_capture.mjpg.subscribed")
    unsub_count = actions.count("live_capture.mjpg.unsubscribed")
    assert sub_count == 1, (sub_count, actions)
    assert unsub_count == 1, (unsub_count, actions)
    # And no per-frame action snuck in.
    assert "live_capture.mjpg.frame" not in actions


def test_mjpg_concurrent_viewer_cap_helpers() -> None:
    """The 11th concurrent viewer must be rejected by the cap helper.

    We exercise the cap primitive (``_try_acquire_mjpeg``) directly
    rather than trying to hold 11 real streams open through the
    synchronous TestClient (which serialises requests). The
    integration check that a 503 actually surfaces — the rest of the
    handler chain after the helper rejects — is validated in the
    physical-validation milestone with a real browser running 11 tabs.
    """

    # Reach into the module via sys.modules — ``import …router as live_router``
    # gets aliased to the package's ``router`` APIRouter attribute by
    # ``__init__.py``'s re-export, so ``from … import``-by-symbol is
    # the unambiguous path.
    from hadir.live_capture.router import (  # noqa: PLC0415
        _mjpeg_counts,
        _mjpeg_lock,
        _release_mjpeg,
        _try_acquire_mjpeg,
    )

    tenant_id, camera_id = 1, 4242

    # Reset the counter for our key (other tests may have leaked).
    with _mjpeg_lock:
        _mjpeg_counts.pop((tenant_id, camera_id), None)

    try:
        for i in range(10):
            ok = _try_acquire_mjpeg(tenant_id, camera_id)
            assert ok, f"acquire {i + 1}/10 should have succeeded"
        # 11th — over the cap.
        assert not _try_acquire_mjpeg(tenant_id, camera_id)
        # Releasing one slot lets the 11th in.
        _release_mjpeg(tenant_id, camera_id)
        assert _try_acquire_mjpeg(tenant_id, camera_id)
    finally:
        with _mjpeg_lock:
            _mjpeg_counts.pop((tenant_id, camera_id), None)


def test_ws_concurrent_subscriber_cap_helpers() -> None:
    """Same shape, this time for the WebSocket subscriber cap."""

    from hadir.live_capture.router import (  # noqa: PLC0415
        _release_ws,
        _try_acquire_ws,
        _ws_counts,
        _ws_lock,
    )

    tenant_id, camera_id = 1, 4243
    with _ws_lock:
        _ws_counts.pop((tenant_id, camera_id), None)
    try:
        for i in range(10):
            assert _try_acquire_ws(tenant_id, camera_id), i
        assert not _try_acquire_ws(tenant_id, camera_id)
        _release_ws(tenant_id, camera_id)
        assert _try_acquire_ws(tenant_id, camera_id)
    finally:
        with _ws_lock:
            _ws_counts.pop((tenant_id, camera_id), None)


# ---------------------------------------------------------------------------
# /live-stats
# ---------------------------------------------------------------------------


def test_live_stats_requires_admin(
    client: TestClient, employee_user: dict, seeded_camera: dict
) -> None:
    _login(client, employee_user)
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/live-stats")
    assert resp.status_code == 403


def test_live_stats_returns_zeroes_for_quiet_camera(
    client: TestClient, admin_user: dict, seeded_camera: dict
) -> None:
    _login(client, admin_user)
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/live-stats")
    assert resp.status_code == 200
    body = resp.json()
    for key in (
        "detections_last_10m",
        "known_count",
        "unknown_count",
        "fps",
        "fps_reader",
        "fps_analyzer",
        "motion_skipped",
        "status",
    ):
        assert key in body, body
    # Newly-seeded camera + no live worker → status offline.
    assert body["status"] == "offline"


def test_live_stats_surfaces_worker_fps_when_running(
    client: TestClient,
    admin_user: dict,
    seeded_camera: dict,
    install_fake_worker,
) -> None:
    install_fake_worker(
        tenant_id=1,
        camera_id=seeded_camera["id"],
        jpeg=b"\xff\xd8\xff\xe0xx\xff\xd9",
    )
    _login(client, admin_user)
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/live-stats")
    assert resp.status_code == 200
    body = resp.json()
    # _FakeWorker.get_stats returns these.
    assert body["fps_reader"] == 12.0
    assert body["fps_analyzer"] == 4.5
    assert body["status"] == "online"


# ---------------------------------------------------------------------------
# /events.csv
# ---------------------------------------------------------------------------


def test_events_csv_returns_header_only_when_empty(
    client: TestClient, admin_user: dict, seeded_camera: dict
) -> None:
    _login(client, admin_user)
    resp = client.get(f"/api/cameras/{seeded_camera['id']}/events.csv?hours=1")
    assert resp.status_code == 200
    body = resp.text
    assert body.startswith("id,captured_at,")
    # Header line + (possibly) a final newline → either 1 or 2 lines.
    lines = [l for l in body.splitlines() if l.strip()]
    assert len(lines) == 1


def test_events_csv_rejects_hours_outside_range(
    client: TestClient, admin_user: dict, seeded_camera: dict
) -> None:
    _login(client, admin_user)
    over = client.get(f"/api/cameras/{seeded_camera['id']}/events.csv?hours=25")
    assert over.status_code == 422
    under = client.get(f"/api/cameras/{seeded_camera['id']}/events.csv?hours=0")
    assert under.status_code == 422


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


def test_events_ws_rejects_anonymous(
    client: TestClient, seeded_camera: dict
) -> None:
    """WS handshake without a session cookie must close immediately."""

    from starlette.websockets import WebSocketDisconnect  # noqa: PLC0415

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/api/cameras/{seeded_camera['id']}/events.ws"
        ):
            pass


def test_events_ws_accepts_admin_and_emits_heartbeat(
    client: TestClient, admin_user: dict, seeded_camera: dict
) -> None:
    """Admin connects with a cookie session; heartbeat arrives within
    ~6 seconds (handler emits one as soon as the queue idle-timeout
    fires, which is ≤ 1 s)."""

    _login(client, admin_user)
    with client.websocket_connect(
        f"/api/cameras/{seeded_camera['id']}/events.ws"
    ) as ws:
        deadline = time.time() + 6.5
        seen_heartbeat = False
        while time.time() < deadline:
            msg = ws.receive_json()
            if msg.get("type") == "heartbeat":
                seen_heartbeat = True
                # The P28.5a heartbeat carries the worker stats fields
                # (None when no worker is running, which is the case
                # here — but the keys are present).
                assert "server_time" in msg
                assert "camera_status" in msg
                assert "fps_reader" in msg
                assert "fps_analyzer" in msg
                break
        assert seen_heartbeat, "no heartbeat received within budget"


def test_events_ws_rejects_non_admin(
    client: TestClient, employee_user: dict, seeded_camera: dict
) -> None:
    _login(client, employee_user)
    from starlette.websockets import WebSocketDisconnect  # noqa: PLC0415

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/api/cameras/{seeded_camera['id']}/events.ws"
        ):
            pass


def test_events_ws_rejects_cross_tenant_camera(
    client: TestClient,
    admin_user: dict,
    install_fake_worker,
) -> None:
    """Admin on tenant 1 cannot subscribe to a camera that lives in
    tenant 99 — same defence-in-depth shape as the MJPEG case."""

    install_fake_worker(tenant_id=99, camera_id=4321, jpeg=b"\xff\xd8\xff\xe0\xff\xd9")
    _login(client, admin_user)
    from starlette.websockets import WebSocketDisconnect  # noqa: PLC0415

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/cameras/4321/events.ws"):
            pass
