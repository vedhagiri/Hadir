"""Regression test for the pipeline-monitor cross-tenant leak (Issue #2).

The clip-pipeline stages are process-global singletons. A worker slot
mid-flight on tenant B's job exposed its concrete ``clip #<id>`` to any
tenant A Admin/HR polling ``GET /api/pipeline-monitor/workers``
(`status_snapshot` ignored the caller's tenant). This test injects a
foreign-tenant busy slot (tenant 999, clip #777) and an own-tenant busy
slot (tenant 1, clip #11), then asserts a tenant-1 view redacts the
foreign clip-id while keeping its own visible — and never leaks the
internal ``current_job_tenant_id`` key.
"""

from __future__ import annotations

import json

from maugood.clip_pipeline.pipeline import ClipPipeline
from maugood.clip_pipeline.stage import StageQueue


def _inject_busy(stage: StageQueue, *, clip_id: int, tenant_id: int, uc: str) -> None:
    slot = stage._slots[0]
    slot.busy = True
    slot.current_job = f"clip #{clip_id} · {uc}"
    slot.current_job_started_at = 1.0
    slot.current_job_tenant_id = tenant_id


def test_pipeline_monitor_redacts_cross_tenant_jobs() -> None:
    p = ClipPipeline()
    p.start()
    try:
        # uc1 worker is busy on FOREIGN tenant 999; uc3 on OWN tenant 1.
        _inject_busy(p._cropping_by_uc["uc1"], clip_id=777, tenant_id=999, uc="UC1")
        _inject_busy(p._cropping_by_uc["uc3"], clip_id=11, tenant_id=1, uc="UC3")

        snap = p.status_snapshot(tenant_id=1)
        blob = json.dumps(snap)

        # The foreign clip-id must NOT appear anywhere in a tenant-1 view.
        assert "777" not in blob, f"CROSS-TENANT LEAK: foreign clip-id visible: {blob}"
        # The internal tenant tag must never reach the response.
        assert "current_job_tenant_id" not in blob, "internal tenant key leaked"

        # Own-tenant job stays visible.
        uc3_jobs = [
            w["current_job"]
            for w in snap["cropping_by_uc"]["uc3"]["workers"] if w["busy"]
        ]
        assert any("11" in j for j in uc3_jobs), f"own job hidden: {uc3_jobs}"

        # Foreign worker still shown as busy (health/utilisation visible),
        # but its job identifier is redacted to "".
        uc1_busy = [w for w in snap["cropping_by_uc"]["uc1"]["workers"] if w["busy"]]
        assert uc1_busy, "foreign worker should still appear (busy), just redacted"
        assert all(w["current_job"] == "" for w in uc1_busy), (
            f"foreign job not redacted: {uc1_busy}"
        )
    finally:
        p.stop()
