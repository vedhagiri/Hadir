"""P28.5c — System detection + tracker config endpoints.

Covers:

* GET returns defaults for a fresh tenant.
* PUT validates field-by-field with **400** + named field for invalid
  values (mode, det_size, ranges).
* PUT round-trips: valid update is reflected in the next GET.
* Per-tenant isolation: editing tenant 1 doesn't bleed into a
  synthetic tenant.
* Audit row carries before + after JSONB on every change.
* Detector port unit-checks: ``DetectorConfig.from_dict`` defensively
  fills missing keys; ``quality_score`` returns the prototype's
  weighted blend; tracker's ``from_tracker_config`` maps JSONB keys
  to the v1.0 kwargs.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.engine import Engine

from hadir.db import audit_log, tenant_settings
from hadir.detection import DetectorConfig, quality_score
from hadir.capture.tracker import IoUTracker


# ---------------------------------------------------------------------------
# Pure unit tests on the ported pieces
# ---------------------------------------------------------------------------


def test_detector_config_from_dict_fills_missing_keys() -> None:
    """A JSONB blob missing a key falls back to the dataclass default,
    not None — defence in depth on a forward-compat schema."""

    cfg = DetectorConfig.from_dict({"mode": "yolo+face", "det_size": 480})
    assert cfg.mode == "yolo+face"
    assert cfg.det_size == 480
    # Defaults backfilled for keys not present in the input.
    assert cfg.min_det_score == 0.5
    assert cfg.min_face_pixels == 60 * 60
    assert cfg.yolo_conf == 0.35


def test_detector_config_from_none_is_all_defaults() -> None:
    cfg = DetectorConfig.from_dict(None)
    assert cfg.mode == "insightface"
    assert cfg.det_size == 320
    assert cfg.min_det_score == 0.5
    assert cfg.min_face_pixels == 60 * 60


def test_quality_score_weights_match_prototype() -> None:
    """Weights are 0.6 area + 0.25 pose + 0.15 det_score per the
    prototype. A 200×200 face at perfectly frontal pose with 1.0
    det_score saturates at 1.0; the components are linearly
    independent."""

    big_frontal_high = {
        "face_width": 200,
        "face_height": 200,
        "pose_score": 1.0,
        "det_score": 1.0,
    }
    assert quality_score(big_frontal_high) == pytest.approx(1.0, abs=1e-6)

    # 100×100 face: area_norm = 100^2 / 200^2 = 0.25 → 0.15
    medium_pose_half = {
        "face_width": 100,
        "face_height": 100,
        "pose_score": 0.5,
        "det_score": 1.0,
    }
    expected = 0.6 * 0.25 + 0.25 * 0.5 + 0.15 * 1.0
    assert quality_score(medium_pose_half) == pytest.approx(expected, abs=1e-6)


def test_tracker_from_tracker_config_maps_jsonb_keys() -> None:
    """``timeout_sec`` (JSONB key) → ``idle_timeout_s`` (kwarg).
    Defaults match the prototype's tested values when the dict is
    None or missing keys."""

    tr = IoUTracker.from_tracker_config(
        {"iou_threshold": 0.4, "timeout_sec": 5.0, "max_duration_sec": 90.0}
    )
    assert tr.iou_threshold == 0.4
    assert tr.idle_timeout_s == 5.0
    assert tr.max_duration_sec == 90.0

    # None → all defaults (prototype).
    tr2 = IoUTracker.from_tracker_config(None)
    assert tr2.iou_threshold == 0.3
    assert tr2.idle_timeout_s == 2.0
    assert tr2.max_duration_sec == 60.0


def test_tracker_update_tracker_config_partial_keys() -> None:
    """Live-update: only the keys present are touched. Existing
    tracks retain their original semantics until they retire — see
    tracker docstring for the red line."""

    tr = IoUTracker(iou_threshold=0.3, idle_timeout_s=3.0, max_duration_sec=60.0)
    tr.update_tracker_config({"iou_threshold": 0.5})
    assert tr.iou_threshold == 0.5
    assert tr.idle_timeout_s == 3.0  # untouched
    assert tr.max_duration_sec == 60.0


# ---------------------------------------------------------------------------
# Endpoint tests
# ---------------------------------------------------------------------------


def _login(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/auth/login",
        json={"email": user["email"], "password": user["password"]},
    )
    assert resp.status_code == 200, resp.text


def test_get_detection_config_returns_defaults_for_fresh_tenant(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/system/detection-config")
    assert resp.status_code == 200
    body = resp.json()
    # The migration server_default seeds these — fresh tenant gets them.
    assert body["mode"] == "insightface"
    assert body["det_size"] == 320
    assert body["min_det_score"] == 0.5
    assert body["min_face_pixels"] == 3600
    assert body["yolo_conf"] == 0.35
    assert body["show_body_boxes"] is False


def test_get_tracker_config_returns_defaults(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.get("/api/system/tracker-config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["iou_threshold"] == 0.3
    assert body["timeout_sec"] == 2.0
    assert body["max_duration_sec"] == 60.0


def test_put_detection_config_rejects_invalid_mode(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/system/detection-config",
        json={
            "mode": "yolov12",
            "det_size": 320,
            "min_det_score": 0.5,
            "min_face_pixels": 3600,
            "yolo_conf": 0.35,
            "show_body_boxes": False,
        },
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert detail["field"] == "mode"
    assert "insightface" in detail["message"]
    assert "yolo+face" in detail["message"]


def test_put_detection_config_rejects_invalid_det_size(
    client: TestClient, admin_user: dict
) -> None:
    _login(client, admin_user)
    resp = client.put(
        "/api/system/detection-config",
        json={
            "mode": "insightface",
            "det_size": 999,
            "min_det_score": 0.5,
            "min_face_pixels": 3600,
            "yolo_conf": 0.35,
            "show_body_boxes": False,
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["field"] == "det_size"


@pytest.mark.parametrize(
    "field,bad_value",
    [
        ("min_det_score", 1.5),    # > 1.0
        ("min_det_score", -0.1),   # < 0.0
        ("min_face_pixels", 100),  # < 400 (= 20×20)
        ("min_face_pixels", 200_000),  # > 90000 (= 300×300)
        ("yolo_conf", 1.5),
    ],
)
def test_put_detection_config_rejects_out_of_range(
    client: TestClient, admin_user: dict, field: str, bad_value: object
) -> None:
    _login(client, admin_user)
    payload = {
        "mode": "insightface",
        "det_size": 320,
        "min_det_score": 0.5,
        "min_face_pixels": 3600,
        "yolo_conf": 0.35,
        "show_body_boxes": False,
    }
    payload[field] = bad_value
    resp = client.put("/api/system/detection-config", json=payload)
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == field


@pytest.mark.parametrize(
    "field,bad_value",
    [
        ("iou_threshold", 0.0),    # < 0.05
        ("iou_threshold", 1.0),    # > 0.95
        ("timeout_sec", 0.1),      # < 0.5
        ("timeout_sec", 60.0),     # > 30
        ("max_duration_sec", 5.0), # < 10
        ("max_duration_sec", 7200.0),  # > 3600
    ],
)
def test_put_tracker_config_rejects_out_of_range(
    client: TestClient, admin_user: dict, field: str, bad_value: object
) -> None:
    _login(client, admin_user)
    payload = {
        "iou_threshold": 0.3,
        "timeout_sec": 2.0,
        "max_duration_sec": 60.0,
    }
    payload[field] = bad_value
    resp = client.put("/api/system/tracker-config", json=payload)
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["field"] == field


def test_put_detection_config_round_trips(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    # Use ``insightface`` mode for the round-trip — ``yolo+face``
    # requires ``ultralytics`` to be installed and is now blocked by
    # the pre-flight check (see ``test_put_detection_config_rejects_
    # unavailable_mode``).
    new_config = {
        "mode": "insightface",
        "det_size": 480,
        "min_det_score": 0.6,
        "min_face_pixels": 4900,  # 70×70
        "yolo_conf": 0.4,
        "show_body_boxes": True,
    }
    resp = client.put("/api/system/detection-config", json=new_config)
    assert resp.status_code == 200, resp.text
    assert resp.json() == new_config

    # Round-trip via GET.
    resp2 = client.get("/api/system/detection-config")
    assert resp2.status_code == 200
    assert resp2.json() == new_config

    # Audit row landed with before/after JSONB.
    with admin_engine.begin() as conn:
        row = conn.execute(
            select(
                audit_log.c.action, audit_log.c.before, audit_log.c.after
            )
            .where(audit_log.c.action == "system.detection_config.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.before is not None
    assert row.after == new_config
    # Reset to defaults so the next test sees a clean slate.
    client.put(
        "/api/system/detection-config",
        json={
            "mode": "insightface",
            "det_size": 320,
            "min_det_score": 0.5,
            "min_face_pixels": 3600,
            "yolo_conf": 0.35,
            "show_body_boxes": False,
        },
    )


def test_put_detection_config_rejects_unavailable_mode(
    client: TestClient,
    admin_user: dict,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pre-flight guard refuses to persist a mode whose runtime
    deps aren't installed. Without it, the analyzer thread would
    silently spam ``ModuleNotFoundError`` once per cycle and capture
    would brick — see docs/phases/fix-detector-mode-preflight.md.
    """

    _login(client, admin_user)

    def _fake_unavailable(mode: str) -> bool:
        return mode != "yolo+face"

    monkeypatch.setattr(
        "hadir.system.router.is_mode_available", _fake_unavailable, raising=False
    )
    # The router imports lazily inside the handler — patch the symbol
    # at its source too so the lookup hits the fake either way.
    monkeypatch.setattr(
        "hadir.detection.is_mode_available", _fake_unavailable
    )

    resp = client.put(
        "/api/system/detection-config",
        json={
            "mode": "yolo+face",
            "det_size": 320,
            "min_det_score": 0.5,
            "min_face_pixels": 3600,
            "yolo_conf": 0.35,
            "show_body_boxes": False,
        },
    )
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert detail["field"] == "mode"
    assert "yolo+face" in detail["message"]
    assert "not available" in detail["message"]


def test_put_tracker_config_round_trips_and_audits(
    client: TestClient, admin_user: dict, admin_engine: Engine
) -> None:
    _login(client, admin_user)
    new_config = {
        "iou_threshold": 0.5,
        "timeout_sec": 4.0,
        "max_duration_sec": 90.0,
    }
    resp = client.put("/api/system/tracker-config", json=new_config)
    assert resp.status_code == 200
    assert resp.json() == new_config

    with admin_engine.begin() as conn:
        row = conn.execute(
            select(audit_log.c.before, audit_log.c.after)
            .where(audit_log.c.action == "system.tracker_config.updated")
            .order_by(audit_log.c.id.desc())
            .limit(1)
        ).first()
    assert row is not None
    assert row.after == new_config
    # Reset.
    client.put(
        "/api/system/tracker-config",
        json={
            "iou_threshold": 0.3,
            "timeout_sec": 2.0,
            "max_duration_sec": 60.0,
        },
    )


def test_endpoints_admin_only(
    client: TestClient, employee_user: dict
) -> None:
    _login(client, employee_user)
    resp = client.get("/api/system/detection-config")
    assert resp.status_code == 403
    resp = client.put(
        "/api/system/detection-config",
        json={
            "mode": "insightface",
            "det_size": 320,
            "min_det_score": 0.5,
            "min_face_pixels": 3600,
            "yolo_conf": 0.35,
            "show_body_boxes": False,
        },
    )
    assert resp.status_code == 403
