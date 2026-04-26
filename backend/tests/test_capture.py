"""End-to-end-ish tests for the capture worker + manager.

No live camera, no InsightFace model. We inject:
- a fake ``VideoCapture`` factory that yields a scripted sequence of
  (ok, frame) tuples, then raises StopIteration to end the loop.
- a ``StubAnalyzer`` that returns canned detections per frame.

The tests then assert that ``detection_events`` rows and
``camera_health_snapshots`` land in Postgres and that one event is
written per **new track**, not per frame.
"""

from __future__ import annotations

import shutil
import time
from datetime import timedelta
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import delete, func, select

from hadir.capture import manager as manager_mod
from hadir.capture.analyzer import Detection
from hadir.capture.events import captures_dir
from hadir.capture.reader import CaptureWorker, ReaderConfig
from hadir.capture.tracker import Bbox
from hadir.cameras import repository as camera_repo
from hadir.cameras import rtsp as rtsp_io
from hadir.config import get_settings
from hadir.db import camera_health_snapshots, cameras, detection_events, get_engine
from hadir.tenants.scope import TenantScope

TENANT = TenantScope(tenant_id=1)


# --- Helpers ---------------------------------------------------------------


def _blank_frame(w: int = 320, h: int = 240) -> np.ndarray:
    # BGR uint8 image, zeros everywhere. OpenCV reads would give us
    # something similar for a dark camera.
    return np.zeros((h, w, 3), dtype=np.uint8)


class _ScriptedCapture:
    """Feeds a finite sequence of (ok, frame) reads then signals EOF."""

    def __init__(self, frames: list[tuple[bool, np.ndarray | None]]) -> None:
        self._frames = list(frames)
        self._released = False

    def isOpened(self) -> bool:
        return not self._released

    def read(self):
        if not self._frames:
            return (False, None)
        return self._frames.pop(0)

    def release(self) -> None:
        self._released = True


class _StubAnalyzer:
    """Returns canned detections keyed by a counter — one list per call."""

    def __init__(self, script: list[list[Detection]]) -> None:
        self._script = list(script)
        self._i = 0

    def detect(self, _frame) -> list[Detection]:
        if self._i >= len(self._script):
            return []
        out = self._script[self._i]
        self._i += 1
        return out


@pytest.fixture
def clean_capture(admin_engine):  # type: ignore[no-untyped-def]
    """Wipe detection_events + health snapshots + cameras + capture files."""

    with admin_engine.begin() as conn:
        conn.execute(delete(detection_events))
        conn.execute(delete(camera_health_snapshots))
        conn.execute(delete(cameras))
    captures_root = Path(get_settings().faces_storage_path) / "captures"
    shutil.rmtree(captures_root, ignore_errors=True)
    yield
    with admin_engine.begin() as conn:
        conn.execute(delete(detection_events))
        conn.execute(delete(camera_health_snapshots))
        conn.execute(delete(cameras))
    shutil.rmtree(captures_root, ignore_errors=True)


def _seed_camera(
    admin_engine,
    *,
    name: str,
    plain_url: str,
    worker_enabled: bool = True,
    display_enabled: bool = True,
    capture_config: dict | None = None,
) -> int:
    """Insert a camera row with a real Fernet ciphertext; returns the id.

    P28.5b: ``enabled`` was split into ``worker_enabled`` +
    ``display_enabled``; ``capture_config`` is the per-camera knob bag.
    Tests that don't care fall back to defaults.
    """

    encrypted = rtsp_io.encrypt_url(plain_url)
    values: dict[str, object] = {
        "tenant_id": TENANT.tenant_id,
        "name": name,
        "location": "",
        "rtsp_url_encrypted": encrypted,
        "worker_enabled": worker_enabled,
        "display_enabled": display_enabled,
    }
    if capture_config is not None:
        values["capture_config"] = capture_config
    with admin_engine.begin() as conn:
        new_id = conn.execute(
            cameras.insert().values(**values).returning(cameras.c.id)
        ).scalar_one()
    return int(new_id)


# --- CaptureWorker emits one event per track entry -----------------------


@pytest.mark.usefixtures("clean_capture")
def test_worker_emits_one_event_per_new_track_not_per_frame(
    admin_engine,
) -> None:
    cam_id = _seed_camera(admin_engine, name="worker-test", plain_url="rtsp://fake/1")

    # 3 frames: frame1 = 1 face, frame2 = same face (slight shift → same
    # track), frame3 = two faces (continuation + one brand-new).
    frames = [
        (True, _blank_frame()),
        (True, _blank_frame()),
        (True, _blank_frame()),
    ]
    detections_script = [
        [Detection(bbox=Bbox(x=10, y=10, w=50, h=50), det_score=0.99)],
        [Detection(bbox=Bbox(x=12, y=12, w=50, h=50), det_score=0.98)],
        [
            Detection(bbox=Bbox(x=14, y=14, w=50, h=50), det_score=0.97),
            Detection(bbox=Bbox(x=200, y=100, w=50, h=50), det_score=0.96),
        ],
    ]
    analyzer = _StubAnalyzer(detections_script)

    worker = CaptureWorker(
        engine=get_engine(),
        scope=TENANT,
        camera_id=cam_id,
        camera_name="worker-test",
        rtsp_url_plain="rtsp://fake/1",
        analyzer=analyzer,
        capture_factory=lambda _url: _ScriptedCapture(frames),
        config=ReaderConfig(
            analyzer_max_fps=1000.0,  # spin through analyzer iterations quickly
            iou_threshold=0.3,
            track_idle_timeout_s=3.0,
            reconnect_backoff_initial_s=0.01,
            reconnect_backoff_max_s=0.01,
            health_interval_s=1000.0,  # suppress health writes in this test
            max_iterations=3,
            # Force every detect call (blank frames produce no motion).
            force_detect_every_s=0.0,
            # Walk every seq sequentially so all 3 scripted detections
            # are consumed by the tracker (P28.5a refactor: production
            # skip-to-latest would otherwise drop intermediate frames).
            analyzer_consume_every_seq=True,
        ),
        # P28.5b: default ``min_face_quality_to_save=0.35`` filters
        # out the 50×50 test bboxes (quality ~0.29). Disable the
        # threshold for tracker-shape tests so we observe the
        # one-event-per-new-track invariant.
        capture_config={"min_face_quality_to_save": 0.0},
    )

    worker.start()
    # Wait for the worker to consume its scripted feed.
    deadline = time.time() + 5.0
    while worker.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    worker.stop()

    with admin_engine.begin() as conn:
        rows = conn.execute(
            select(detection_events.c.id, detection_events.c.track_id).where(
                detection_events.c.camera_id == cam_id
            )
        ).all()

    # 3 frames produced 2 NEW tracks (frame1 + frame3's second face);
    # frame2 and frame3's first face were continuations.
    assert len(rows) == 2, f"expected 2 events, got {len(rows)}: {rows}"
    assert len({r.track_id for r in rows}) == 2


# --- Face crops on disk are Fernet-encrypted -----------------------------


@pytest.mark.usefixtures("clean_capture")
def test_event_crops_on_disk_are_encrypted_not_jpeg(admin_engine) -> None:
    cam_id = _seed_camera(admin_engine, name="crop-test", plain_url="rtsp://fake/2")

    analyzer = _StubAnalyzer(
        [[Detection(bbox=Bbox(x=20, y=20, w=40, h=40), det_score=0.95)]]
    )
    frames = [(True, _blank_frame())]

    worker = CaptureWorker(
        engine=get_engine(),
        scope=TENANT,
        camera_id=cam_id,
        camera_name="crop-test",
        rtsp_url_plain="rtsp://fake/2",
        analyzer=analyzer,
        capture_factory=lambda _url: _ScriptedCapture(frames),
        config=ReaderConfig(
            analyzer_max_fps=1000.0,
            reconnect_backoff_initial_s=0.01,
            reconnect_backoff_max_s=0.01,
            health_interval_s=1000.0,
            max_iterations=1,
            force_detect_every_s=0.0,
            analyzer_consume_every_seq=True,
        ),
        # P28.5b: same reasoning as the tracker-shape test — disable
        # the quality threshold so test bboxes (small) reach the
        # face-save path.
        capture_config={"min_face_quality_to_save": 0.0},
    )

    worker.start()
    deadline = time.time() + 5.0
    while worker.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    worker.stop()

    # Exactly one event row, with a non-empty face_crop_path.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(
                detection_events.c.face_crop_path,
                detection_events.c.bbox,
                detection_events.c.track_id,
                detection_events.c.employee_id,
                detection_events.c.embedding,
                detection_events.c.confidence,
            ).where(detection_events.c.camera_id == cam_id)
        ).one()
    assert row.face_crop_path
    assert row.employee_id is None  # P9 fills this
    assert row.embedding is None    # P9 fills this
    assert row.confidence is None
    assert set(row.bbox.keys()) == {"x", "y", "w", "h"}

    # File exists and its first bytes are NOT the JPEG magic.
    p = Path(row.face_crop_path)
    assert p.exists()
    assert p.read_bytes()[:3] != b"\xff\xd8\xff"
    # Fernet tokens on disk start with 'gAAAAA' → base64('gAAAA...') = 'Z0FBQ...'
    # but raw Fernet ciphertext bytes begin with 0x80 0x00 etc. Either way, the
    # point is 'not a JPEG'. We already asserted that above.

    # And the configured captures_dir for today owns the file.
    expected_root = captures_dir(TENANT.tenant_id, cam_id)
    assert str(p.parent) == str(expected_root)


# --- Manager hot-reload on camera CRUD ------------------------------------


@pytest.mark.usefixtures("clean_capture")
def test_manager_hot_reload_cycle(admin_engine) -> None:
    """Spin up, create a camera, delete it, and confirm the worker set shrinks."""

    # Stub the analyzer factory so the manager never touches InsightFace.
    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))

    # Swap the default capture factory too, so no thread tries to hit an
    # actual RTSP endpoint. Monkey-patch the module's default_capture_factory
    # so new workers pick it up through the normal import path.
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,  # don't actually reconnect
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        # Tenant 1 (main) starts with no enabled cameras — the
        # ``clean_capture`` fixture wipes its cameras table. Other
        # tenants' workers (e.g. tenant_mts_demo's Giri Home from a
        # dev seed) may be running; we scope the assertion to tenant 1.
        assert mgr.active_camera_ids(tenant_id=1) == []

        cam_id = _seed_camera(
            admin_engine, name="hot-reload", plain_url="rtsp://fake/3"
        )
        mgr.on_camera_created(cam_id, tenant_id=1)
        # Give the worker a beat to spin up (it's a new thread).
        time.sleep(0.1)
        assert cam_id in mgr.active_camera_ids(tenant_id=1)

        # Delete the camera row then notify — worker should be dropped.
        with admin_engine.begin() as conn:
            conn.execute(delete(cameras).where(cameras.c.id == cam_id))
        mgr.on_camera_deleted(cam_id, tenant_id=1)
        time.sleep(0.1)
        assert cam_id not in mgr.active_camera_ids(tenant_id=1)

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


# --- Health snapshot written on schedule ---------------------------------


@pytest.mark.usefixtures("clean_capture")
def test_worker_writes_health_snapshot(admin_engine) -> None:
    """Run one frame then let the loop exit so the tail-flush writes a row."""

    cam_id = _seed_camera(
        admin_engine, name="health-test", plain_url="rtsp://fake/4"
    )
    analyzer = _StubAnalyzer([[]])  # no detections, health path only
    frames = [(True, _blank_frame())]

    worker = CaptureWorker(
        engine=get_engine(),
        scope=TENANT,
        camera_id=cam_id,
        camera_name="health-test",
        rtsp_url_plain="rtsp://fake/4",
        analyzer=analyzer,
        capture_factory=lambda _url: _ScriptedCapture(frames),
        config=ReaderConfig(
            analyzer_max_fps=1000.0,
            reconnect_backoff_initial_s=0.01,
            reconnect_backoff_max_s=0.01,
            health_interval_s=1000.0,
            max_iterations=1,
            force_detect_every_s=0.0,
            analyzer_consume_every_seq=True,
        ),
        # P28.5b: same reasoning as the tracker-shape test — disable
        # the quality threshold so test bboxes (small) reach the
        # face-save path.
        capture_config={"min_face_quality_to_save": 0.0},
    )
    worker.start()
    deadline = time.time() + 5.0
    while worker.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    worker.stop()

    with admin_engine.begin() as conn:
        count = conn.execute(
            select(func.count()).select_from(camera_health_snapshots).where(
                camera_health_snapshots.c.camera_id == cam_id
            )
        ).scalar_one()
    # We expect at least one health row: the tail flush after the
    # max_iterations exit. The unreachable path could also write another
    # one when the follow-up reconnect opens but the scripted capture
    # is exhausted; either way, >= 1 is the contract we care about.
    assert count >= 1


# --- Durability contract ---------------------------------------------------


@pytest.mark.usefixtures("clean_capture")
def test_recent_events_query_shape_matches_pilot_check(admin_engine) -> None:
    """Sanity check for the pilot verification SQL.

    The pilot plan asks operators to run:
      SELECT COUNT(*) FROM detection_events
      WHERE captured_at > now() - interval '5 minutes';
    This test confirms the table + column shape our emitter writes are
    exactly what that query expects.
    """

    cam_id = _seed_camera(
        admin_engine, name="shape-test", plain_url="rtsp://fake/5"
    )
    analyzer = _StubAnalyzer(
        [[Detection(bbox=Bbox(x=5, y=5, w=30, h=30), det_score=0.9)]]
    )
    frames = [(True, _blank_frame())]

    worker = CaptureWorker(
        engine=get_engine(),
        scope=TENANT,
        camera_id=cam_id,
        camera_name="shape-test",
        rtsp_url_plain="rtsp://fake/5",
        analyzer=analyzer,
        capture_factory=lambda _url: _ScriptedCapture(frames),
        config=ReaderConfig(
            analyzer_max_fps=1000.0,
            reconnect_backoff_initial_s=0.01,
            reconnect_backoff_max_s=0.01,
            health_interval_s=1000.0,
            max_iterations=1,
            force_detect_every_s=0.0,
            analyzer_consume_every_seq=True,
        ),
        # P28.5b: same reasoning as the tracker-shape test — disable
        # the quality threshold so test bboxes (small) reach the
        # face-save path.
        capture_config={"min_face_quality_to_save": 0.0},
    )
    worker.start()
    deadline = time.time() + 5.0
    while worker.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    worker.stop()

    from datetime import datetime, timezone

    with admin_engine.begin() as conn:
        count = conn.execute(
            select(func.count())
            .select_from(detection_events)
            .where(
                detection_events.c.captured_at
                > datetime.now(tz=timezone.utc) - timedelta(minutes=5)
            )
        ).scalar_one()
    assert count >= 1


# --- P28.5a: boot-time auto-start ----------------------------------------


@pytest.mark.usefixtures("clean_capture")
def test_manager_auto_starts_workers_for_enabled_cameras_at_boot(
    admin_engine,
) -> None:
    """Manager.start() must spawn one worker per enabled camera across
    every active tenant in ``public.tenants`` — independent of
    ``HADIR_TENANT_MODE``. The bug fixed by this test:
    pre-fix the single-mode branch only scanned the default tenant
    schema and missed cameras living in tenant_<slug> schemas.
    """

    # Patch CaptureWorker so the spawned worker doesn't try to open a
    # real RTSP socket. The fake VideoCapture always returns (False,
    # None) so the reader thread enters reconnect mode but the worker
    # itself is_alive — that's all this test cares about.
    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    cam_id = _seed_camera(
        admin_engine, name="boot-auto-start", plain_url="rtsp://fake/auto"
    )

    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,  # don't reconnect mid-test
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )

        # Worker must be running for the seeded enabled camera under
        # tenant 1 — without the fix, single-mode skipped the per-tenant
        # discovery loop and this assertion failed.
        time.sleep(0.1)
        snapshot = mgr.workers_snapshot()
        assert (1, cam_id) in snapshot, snapshot

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


@pytest.mark.usefixtures("clean_capture")
def test_manager_continues_when_one_camera_fails_to_decrypt(
    admin_engine,
) -> None:
    """A single bad camera (decrypt fail) must not block other cameras
    from starting. The bad camera audits as
    ``capture.worker.start_failed``; the good cameras audit as
    ``capture.worker.started_at_boot``."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    # Good camera — real Fernet ciphertext.
    good_id = _seed_camera(
        admin_engine, name="good", plain_url="rtsp://fake/good"
    )
    # Bad camera — write garbage into ``rtsp_url_encrypted`` so
    # rtsp_io.decrypt_url raises RuntimeError.
    with admin_engine.begin() as conn:
        bad_id = conn.execute(
            cameras.insert()
            .values(
                tenant_id=TENANT.tenant_id,
                name="bad",
                location="",
                rtsp_url_encrypted="not-a-fernet-token",
                worker_enabled=True,
            )
            .returning(cameras.c.id)
        ).scalar_one()
    bad_id = int(bad_id)

    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )

        time.sleep(0.1)
        snapshot = mgr.workers_snapshot()
        # Good worker spawned despite the bad one failing.
        assert (1, good_id) in snapshot, snapshot
        assert (1, bad_id) not in snapshot, snapshot

        # Audit rows: one started_at_boot for good, one
        # start_failed for bad.
        from hadir.db import audit_log  # noqa: PLC0415

        with admin_engine.begin() as conn:
            rows = conn.execute(
                select(
                    audit_log.c.action, audit_log.c.entity_id
                ).where(
                    audit_log.c.action.in_(
                        [
                            "capture.worker.started_at_boot",
                            "capture.worker.start_failed",
                        ]
                    )
                )
            ).all()
        actions = {(r.action, r.entity_id) for r in rows}
        assert ("capture.worker.started_at_boot", str(good_id)) in actions
        assert ("capture.worker.start_failed", str(bad_id)) in actions

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


@pytest.mark.usefixtures("clean_capture")
def test_disable_camera_via_crud_stops_worker_synchronously(
    admin_engine,
) -> None:
    """Toggling enabled=true → enabled=false via the CRUD-style hook
    must stop the worker without waiting for any poll loop. The hook
    re-fetches the row, sees enabled=False, and calls stop_camera."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    cam_id = _seed_camera(
        admin_engine, name="enabled-toggle", plain_url="rtsp://fake/x"
    )

    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        time.sleep(0.1)
        assert (1, cam_id) in mgr.workers_snapshot()

        # Flip worker_enabled=False on the row, fire the CRUD hook,
        # expect the worker to be gone within 1 second.
        with admin_engine.begin() as conn:
            conn.execute(
                cameras.update()
                .where(cameras.c.id == cam_id)
                .values(worker_enabled=False)
            )
        mgr.on_camera_updated(cam_id, tenant_id=1)

        deadline = time.time() + 1.0
        while time.time() < deadline:
            if (1, cam_id) not in mgr.workers_snapshot():
                break
            time.sleep(0.05)
        assert (1, cam_id) not in mgr.workers_snapshot()

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


# --- P28.5b: reconcile loop + capture_config propagation -----------------


@pytest.mark.usefixtures("clean_capture")
def test_reconcile_starts_worker_on_worker_enabled_flip_true(
    admin_engine,
) -> None:
    """A camera written ``worker_enabled=true`` directly in the DB
    (out-of-band — no CRUD hook fired) must get a worker on the next
    reconcile pass. P28.5b's load-bearing red line: out-of-band
    mutations don't drop on the floor."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    # Seed a camera with worker_enabled=False — so the boot scan sees
    # nothing and no worker spins up.
    cam_id = _seed_camera(
        admin_engine, name="reconcile-target",
        plain_url="rtsp://fake/reconcile",
        worker_enabled=False,
    )
    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        assert (1, cam_id) not in mgr.workers_snapshot()

        # Out-of-band flip: write directly to the row without firing
        # the CRUD hook. The reconcile pass should pick it up.
        with admin_engine.begin() as conn:
            conn.execute(
                cameras.update()
                .where(cameras.c.id == cam_id)
                .values(worker_enabled=True)
            )

        report = mgr.reconcile_all()
        assert report["started"] >= 1, report
        time.sleep(0.05)
        assert (1, cam_id) in mgr.workers_snapshot()

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


@pytest.mark.usefixtures("clean_capture")
def test_reconcile_stops_worker_on_worker_enabled_flip_false(
    admin_engine,
) -> None:
    """Mirror of the above — a worker_enabled=true → false flip
    out-of-band must stop the worker on the next reconcile pass."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    cam_id = _seed_camera(
        admin_engine, name="reconcile-stop",
        plain_url="rtsp://fake/reconcile-stop",
    )
    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        time.sleep(0.05)
        assert (1, cam_id) in mgr.workers_snapshot()

        with admin_engine.begin() as conn:
            conn.execute(
                cameras.update()
                .where(cameras.c.id == cam_id)
                .values(worker_enabled=False)
            )
        report = mgr.reconcile_all()
        assert report["stopped"] >= 1, report
        time.sleep(0.05)
        assert (1, cam_id) not in mgr.workers_snapshot()

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


@pytest.mark.usefixtures("clean_capture")
def test_reconcile_propagates_capture_config_change_without_restart(
    admin_engine,
) -> None:
    """Updating ``capture_config`` on the row must propagate to the
    worker via ``update_config`` without spawning a new worker. The
    audit row records before/after under
    ``capture.worker.config_updated``."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    cam_id = _seed_camera(
        admin_engine, name="config-target",
        plain_url="rtsp://fake/config",
    )
    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        time.sleep(0.05)
        assert (1, cam_id) in mgr.workers_snapshot()

        # Capture the worker instance so we can compare identity
        # before/after — it must NOT be replaced.
        before_workers = dict(mgr._workers)  # noqa: SLF001
        worker_before = before_workers[(1, cam_id)]

        # Tweak the config; reconcile_all should pick up the diff.
        new_config = {
            "max_faces_per_event": 3,
            "max_event_duration_sec": 30,
            "min_face_quality_to_save": 0.5,
            "save_full_frames": True,
        }
        with admin_engine.begin() as conn:
            conn.execute(
                cameras.update()
                .where(cameras.c.id == cam_id)
                .values(capture_config=new_config)
            )

        report = mgr.reconcile_all()
        assert report["config_updated"] >= 1, report

        # Same worker instance — no restart.
        after_workers = dict(mgr._workers)  # noqa: SLF001
        assert after_workers[(1, cam_id)] is worker_before
        # And the worker carries the new config now.
        assert worker_before.get_capture_config()["max_faces_per_event"] == 3
        assert worker_before.get_capture_config()["save_full_frames"] is True

        # Audit row must carry before + after JSONB.
        from hadir.db import audit_log  # noqa: PLC0415

        with admin_engine.begin() as conn:
            row = conn.execute(
                select(
                    audit_log.c.action, audit_log.c.before, audit_log.c.after
                ).where(
                    audit_log.c.action == "capture.worker.config_updated",
                    audit_log.c.entity_id == str(cam_id),
                ).order_by(audit_log.c.id.desc()).limit(1)
            ).first()
        assert row is not None
        # The "before" we recorded carries the config that was on the
        # worker prior to the update. The "after" matches our new dict.
        assert row.after["max_faces_per_event"] == 3
        assert row.after["save_full_frames"] is True

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()


def test_quality_score_filters_low_quality_below_threshold() -> None:
    """``min_face_quality_to_save`` gates whether a detection becomes
    a row. Below threshold → ``emit_detection_event`` returns None
    without writing to disk or DB. Pure unit test on the threshold
    arithmetic; no DB or filesystem touched."""

    from hadir.capture.events import quality_score
    from hadir.capture.tracker import Bbox

    # 60×60 face at det_score 0.9: area_norm = 3600/40000 = 0.09
    #   → 0.75*0.09 + 0.25*0.9 = 0.0675 + 0.225 = 0.2925. Below 0.35.
    small = Bbox(x=0, y=0, w=60, h=60)
    assert quality_score(small, det_score=0.9) < 0.35

    # 200×200 face at det_score 0.9: area saturates → 0.75 + 0.225 = 0.975
    big = Bbox(x=0, y=0, w=200, h=200)
    assert quality_score(big, det_score=0.9) > 0.35


def test_tracker_force_retires_after_max_duration_sec() -> None:
    """The tracker drops a track whose age exceeds ``max_duration_sec``
    even when the detection is still present. Ensures the prototype's
    MAX_EVENT_DURATION_SEC behaviour landed in our IoUTracker."""

    from hadir.capture.tracker import Bbox, IoUTracker

    tr = IoUTracker(
        iou_threshold=0.3,
        idle_timeout_s=60.0,
        max_duration_sec=2.0,
    )
    # Mint a track at t=0.
    bbox = Bbox(x=10, y=10, w=50, h=50)
    matches = tr.update([bbox], 0.0)
    assert len(matches) == 1 and matches[0].is_new

    # Same bbox at t=1.5 — within max_duration_sec — continuation.
    matches = tr.update([bbox], 1.5)
    assert matches[0].is_new is False

    # At t=3.0 (> 2.0 max) the same bbox should mint a fresh track.
    matches = tr.update([bbox], 3.0)
    assert matches[0].is_new is True
    assert matches[0].track_id != ""


@pytest.mark.usefixtures("clean_capture")
def test_per_tenant_config_changes_isolated(admin_engine) -> None:
    """Changing tenant 1's camera capture_config must not affect any
    other tenant's workers. Lightweight unit-y test that operates on
    the manager's internal workers dict directly."""

    from hadir.capture.analyzer import (
        clear_analyzer_factory,
        set_analyzer_factory,
    )

    set_analyzer_factory(lambda: _StubAnalyzer([]))
    original_default = manager_mod.CaptureWorker

    class _WorkerWithFakeCapture(original_default):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault(
                "capture_factory",
                lambda _url: _ScriptedCapture([(False, None)]),
            )
            super().__init__(*args, **kwargs)

    manager_mod.CaptureWorker = _WorkerWithFakeCapture  # type: ignore[assignment]

    cam_id_t1 = _seed_camera(
        admin_engine, name="tenant1-cam",
        plain_url="rtsp://fake/t1",
    )

    try:
        mgr = manager_mod.CaptureManager()
        mgr.start(
            config=ReaderConfig(
                analyzer_max_fps=1000.0,
                reconnect_backoff_initial_s=10.0,
                reconnect_backoff_max_s=10.0,
                health_interval_s=1000.0,
            )
        )
        time.sleep(0.05)

        # Synthetic "other tenant" worker — install a fake worker on
        # key (99, 1). Its config must remain untouched when we tweak
        # tenant 1's row.
        from tests.test_live_capture import _FakeWorker  # noqa: PLC0415

        synthetic = _FakeWorker(camera_id=1, jpeg=b"\xff\xd8\xff\xe0\xff\xd9")
        # Monkey-patch get_capture_config + update_config onto the
        # fake (it doesn't own a real config bag).
        synthetic._cfg = {"max_faces_per_event": 10}  # type: ignore[attr-defined]
        synthetic.get_capture_config = lambda: dict(synthetic._cfg)  # type: ignore[attr-defined]
        synthetic.update_config = lambda c: synthetic._cfg.update(c)  # type: ignore[attr-defined]
        with mgr._lock:  # noqa: SLF001
            mgr._workers[(99, 1)] = synthetic  # noqa: SLF001 # type: ignore[assignment]

        # Tweak tenant 1's config.
        with admin_engine.begin() as conn:
            conn.execute(
                cameras.update()
                .where(cameras.c.id == cam_id_t1)
                .values(capture_config={
                    "max_faces_per_event": 7,
                    "max_event_duration_sec": 60,
                    "min_face_quality_to_save": 0.35,
                    "save_full_frames": False,
                })
            )

        mgr.reconcile_all()

        # Tenant 1's worker has the new config.
        with mgr._lock:  # noqa: SLF001
            t1_worker = mgr._workers.get((1, cam_id_t1))  # noqa: SLF001
        assert t1_worker is not None
        assert t1_worker.get_capture_config()["max_faces_per_event"] == 7

        # Synthetic tenant 99's worker config is untouched —
        # reconcile_all only saw tenant 1's row, so it didn't touch
        # other workers' configs (and tenant 99 doesn't even have a
        # row in public.tenants, so it falls outside the
        # reconcile_all scan entirely).
        assert synthetic.get_capture_config()["max_faces_per_event"] == 10

        mgr.stop()
    finally:
        manager_mod.CaptureWorker = original_default  # type: ignore[assignment]
        clear_analyzer_factory()
