"""FastAPI router — Pipeline Analytics (Admin / HR).

* ``GET /api/pipeline-analytics/summary``    — UC1-vs-UC2 stage-time aggregates
* ``GET /api/pipeline-analytics/clips``       — paginated per-clip metric rows
* ``GET /api/pipeline-analytics/export.csv``  — CSV of all matching rows

All read-only. Filters: ``use_case`` (uc1|uc2), ``camera_id``, ``start``,
``end`` (ISO), ``status``.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Iterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select as sa_select

from maugood.auth.audit import write_audit
from maugood.auth.dependencies import CurrentUser, require_any_role
from maugood.db import get_engine, person_clips
from maugood.employees.photos import decrypt_bytes
from maugood.pipeline_analytics import queries
from maugood.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pipeline-analytics", tags=["pipeline-analytics"])

ADMIN_OR_HR = Depends(require_any_role("Admin", "HR"))
ADMIN_ONLY = Depends(require_any_role("Admin"))

# Hard cap on clips bundled into a ZIP — a decrypted-MP4 download can be
# gigabytes, so we never bundle more than this (operator narrows the
# date/UC filter to get the set they want). Env-overridable.
MAX_ZIP_CLIPS = int(os.environ.get("MAUGOOD_PIPELINE_ZIP_MAX_CLIPS", "150") or "150")


def _csv_text(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(queries.CLIP_COLUMNS))
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {k: ("" if row.get(k) is None else row[k]) for k in queries.CLIP_COLUMNS}
        )
    return buf.getvalue()


def _parse_iso(value: Optional[str], field: str) -> Optional[datetime]:
    if not value:
        return None
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(v)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid {field}") from exc


@router.get("/summary")
def get_summary(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    use_case: Optional[str] = Query(default=None, pattern=r"^(uc1|uc2)$"),
    camera_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
    status: Optional[str] = Query(
        default="completed",
        pattern=r"^(completed|failed|processing|pending|all)$",
    ),
) -> dict:
    scope = TenantScope(tenant_id=user.tenant_id)
    status_filter = None if status == "all" else status
    with get_engine().begin() as conn:
        rows = queries.summary(
            conn, scope,
            use_case=use_case, camera_id=camera_id,
            start=_parse_iso(start, "start"), end=_parse_iso(end, "end"),
            status=status_filter,
        )
    return {"use_cases": rows}


@router.get("/clips")
def get_clips(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    use_case: Optional[str] = Query(default=None, pattern=r"^(uc1|uc2)$"),
    camera_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
    status: Optional[str] = Query(
        default=None, pattern=r"^(completed|failed|processing|pending)$"
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        items, total = queries.list_clips(
            conn, scope,
            use_case=use_case, camera_id=camera_id,
            start=_parse_iso(start, "start"), end=_parse_iso(end, "end"),
            status=status, page=page, page_size=page_size,
        )
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/export.csv")
def export_csv(
    user: Annotated[CurrentUser, ADMIN_OR_HR],
    use_case: Optional[str] = Query(default=None, pattern=r"^(uc1|uc2)$"),
    camera_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
    status: Optional[str] = Query(
        default=None, pattern=r"^(completed|failed|processing|pending)$"
    ),
) -> Response:
    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = queries.all_clips_for_export(
            conn, scope,
            use_case=use_case, camera_id=camera_id,
            start=_parse_iso(start, "start"), end=_parse_iso(end, "end"),
            status=status,
        )

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")  # noqa: DTZ005 — filename only
    uc = use_case or "all"
    filename = f"pipeline-analytics-{uc}-{stamp}.csv"
    return Response(
        content=_csv_text(rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export.zip")
def export_zip(
    user: Annotated[CurrentUser, ADMIN_ONLY],
    use_case: Optional[str] = Query(default=None, pattern=r"^(uc1|uc2)$"),
    camera_id: Optional[int] = Query(default=None),
    start: Optional[str] = Query(default=None, description="ISO datetime"),
    end: Optional[str] = Query(default=None, description="ISO datetime"),
    status: Optional[str] = Query(
        default=None, pattern=r"^(completed|failed|processing|pending)$"
    ),
) -> StreamingResponse:
    """Streamed ZIP: performance.csv + the decrypted MP4 clips (capped at
    ``MAX_ZIP_CLIPS``, slowest first). Admin-only + audited — the clips
    are decrypted PII, so this mirrors the old shell-script bundle but
    in-app and access-controlled.
    """

    scope = TenantScope(tenant_id=user.tenant_id)
    with get_engine().begin() as conn:
        rows = queries.all_clips_for_export(
            conn, scope,
            use_case=use_case, camera_id=camera_id,
            start=_parse_iso(start, "start"), end=_parse_iso(end, "end"),
            status=status, cap=MAX_ZIP_CLIPS,
        )
        # Resolve file paths for the capped clip set (one query).
        clip_ids = [r["clip_id"] for r in rows]
        path_by_id: dict[int, str] = {}
        if clip_ids:
            for pr in conn.execute(
                sa_select(person_clips.c.id, person_clips.c.file_path).where(
                    person_clips.c.tenant_id == scope.tenant_id,
                    person_clips.c.id.in_(clip_ids),
                )
            ).all():
                if pr.file_path:
                    path_by_id[int(pr.id)] = str(pr.file_path)
        write_audit(
            conn,
            tenant_id=scope.tenant_id,
            actor_user_id=user.id,
            action="pipeline_analytics.export_zip",
            entity_type="pipeline_analytics",
            entity_id=None,
            after={
                "clips": len(rows),
                "with_files": len(path_by_id),
                "use_case": use_case or "all",
                "capped": len(rows) >= MAX_ZIP_CLIPS,
            },
        )

    csv_text = _csv_text(rows)

    def _gen() -> Iterator[bytes]:
        sink = _ZipSink()
        zf = zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True)
        zf.writestr("performance.csv", csv_text)
        yield from sink.drain()
        for r in rows:
            path = path_by_id.get(r["clip_id"])
            if not path:
                continue
            try:
                data = decrypt_bytes(Path(path).read_bytes())
            except Exception:  # noqa: BLE001 — skip unreadable/decrypt-fail clips
                continue
            zf.writestr(f"clips/clip_{r['clip_id']}_{r['use_case']}.mp4", data)
            yield from sink.drain()
        zf.close()
        yield from sink.drain()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")  # noqa: DTZ005 — filename only
    uc = use_case or "all"
    filename = f"pipeline-analytics-{uc}-{stamp}.zip"
    return StreamingResponse(
        _gen(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


class _ZipSink:
    """Write-only sink for streaming a ZipFile. No ``tell``/``seek`` →
    zipfile uses data descriptors (no seeking back), so we can stream the
    archive out chunk-by-chunk holding only one clip in memory at a time."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []

    def write(self, b) -> int:  # type: ignore[no-untyped-def]
        self._chunks.append(bytes(b))
        return len(b)

    def flush(self) -> None:
        pass

    def drain(self) -> Iterator[bytes]:
        chunks, self._chunks = self._chunks, []
        yield from chunks
