"""compare_uc2.py — Side-by-side OLD vs NEW UC2 face-crop comparison.

Run UC2 again against clips that already have UC2 history, preserve
the existing crops under ``use_case='uc2_legacy'``, and emit a static
HTML report you can open in a browser to compare old vs new.

Usage (inside the backend container):

    python -m scripts.compare_uc2 --schema tenant_inaisys --clip 711 712 713
    python -m scripts.compare_uc2 --schema main --recent 5

The HTML report lands at::

    /face_crops/_comparisons/<timestamp>/index.html

which is mounted on the host as ``./data/face_crops/_comparisons/<ts>/``
— open ``index.html`` directly in your browser.

What it does, per clip
──────────────────────
1. Snapshots the current UC2 crops (decrypts encrypted JPEGs and writes
   plaintext copies to the comparison dir, ``old/`` subfolder).
2. UPDATEs the DB so existing ``use_case='uc2'`` rows for the clip
   become ``use_case='uc2_legacy'``. They stay queryable but the
   frontend (which only knows uc1/uc2/uc3) hides them.
3. Calls ``process_single_clip`` with ``use_cases=('uc2',)`` — the new
   reference-parity pipeline runs.
4. Snapshots the freshly written UC2 crops to the comparison dir's
   ``new/`` subfolder.
5. Writes ``index.html`` with old + new galleries side-by-side and
   per-crop metadata (composite quality, det score, employee match,
   dimensions).

Red lines
─────────
* Refuses to run on a clip that has no existing UC2 rows (nothing to
  compare against — use the normal right-click → UC2 menu instead).
* Writes plaintext JPEGs to the comparison dir; treat the comparison
  dir as sensitive output.
* The DB reflag is one-way for this script: re-running it on the same
  clip will append a new ``new/`` snapshot but the legacy rows remain
  legacy. Reverse with::

      UPDATE face_crops SET use_case='uc2'
       WHERE use_case='uc2_legacy' AND person_clip_id = <id>;
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import desc, select, update as sa_update, text

from maugood.db import face_crops, get_engine, person_clips, tenant_context
from maugood.employees.photos import decrypt_bytes
from maugood.person_clips.reprocess import process_single_clip
from maugood.tenants.scope import TenantScope


logger = logging.getLogger("compare_uc2")


# Comparison artefacts land here; the docker-compose mounts
# ./data/face_crops -> /face_crops so the host can browse the output.
COMPARISON_ROOT = Path("/face_crops/_comparisons")


def _resolve_tenant_id(schema: str) -> int:
    """Look up the public.tenants row for the given schema name."""
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT id FROM public.tenants WHERE schema_name = :s"),
            {"s": schema},
        ).first()
    if row is None:
        raise SystemExit(f"unknown tenant schema: {schema}")
    return int(row.id)


def _snapshot_crops(
    scope: TenantScope,
    clip_id: int,
    use_case: str,
    out_dir: Path,
    *,
    only_created_after: Optional[datetime] = None,
) -> list[dict]:
    """Decrypt every ``face_crops`` row for ``(clip, use_case)`` to
    plaintext JPEGs under ``out_dir``. Returns a list of metadata
    dicts describing each saved file.

    ``only_created_after`` lets the post-rerun snapshot pick up just
    the rows produced by the new run; pass the run-start timestamp.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    engine = get_engine()
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            q = (
                select(
                    face_crops.c.id,
                    face_crops.c.file_path,
                    face_crops.c.width,
                    face_crops.c.height,
                    face_crops.c.employee_id,
                    face_crops.c.quality_score,
                    face_crops.c.detection_score,
                    face_crops.c.created_at,
                )
                .where(face_crops.c.person_clip_id == clip_id)
                .where(face_crops.c.tenant_id == scope.tenant_id)
                .where(face_crops.c.use_case == use_case)
            )
            if only_created_after is not None:
                q = q.where(face_crops.c.created_at >= only_created_after)
            rows = conn.execute(q.order_by(face_crops.c.id)).fetchall()

    summaries: list[dict] = []
    for r in rows:
        if not r.file_path:
            continue
        src = Path(str(r.file_path))
        if not src.exists():
            logger.warning(
                "crop file missing on disk: clip=%s row_id=%s path=%s",
                clip_id, r.id, src,
            )
            continue
        try:
            plain = decrypt_bytes(src.read_bytes())
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "decrypt failed: clip=%s row_id=%s reason=%s",
                clip_id, r.id, type(exc).__name__,
            )
            continue

        # Filename stays parseable so the HTML can read metadata from it.
        emp_tag = f"emp{r.employee_id}" if r.employee_id is not None else "unknown"
        qpct = int(round(float(r.quality_score or 0) * 100))
        fname = f"row{r.id:06d}_{emp_tag}_q{qpct:03d}.jpg"
        (out_dir / fname).write_bytes(plain)

        summaries.append(
            {
                "row_id": int(r.id),
                "filename": fname,
                "width": int(r.width or 0),
                "height": int(r.height or 0),
                "employee_id": r.employee_id,
                "quality_score": float(r.quality_score or 0),
                "detection_score": float(r.detection_score or 0),
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
        )
    return summaries


def _reflag_legacy(scope: TenantScope, clip_id: int) -> int:
    """UPDATE ``use_case='uc2'`` rows for the clip to
    ``use_case='uc2_legacy'`` so the next UC2 run produces fresh
    ``uc2`` rows alongside the preserved legacy ones. Returns the
    row count flipped."""
    engine = get_engine()
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            result = conn.execute(
                sa_update(face_crops)
                .where(face_crops.c.person_clip_id == clip_id)
                .where(face_crops.c.tenant_id == scope.tenant_id)
                .where(face_crops.c.use_case == "uc2")
                .values(use_case="uc2_legacy")
            )
            return int(result.rowcount or 0)


def _fetch_clip_meta(scope: TenantScope, clip_id: int) -> Optional[dict]:
    engine = get_engine()
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            r = conn.execute(
                select(
                    person_clips.c.id,
                    person_clips.c.camera_id,
                    person_clips.c.clip_start,
                    person_clips.c.duration_seconds,
                    person_clips.c.person_count,
                    person_clips.c.detection_source,
                )
                .where(person_clips.c.id == clip_id)
                .where(person_clips.c.tenant_id == scope.tenant_id)
            ).first()
    if r is None:
        return None
    return {
        "id": int(r.id),
        "camera_id": int(r.camera_id),
        "clip_start": r.clip_start.isoformat() if r.clip_start else "",
        "duration_seconds": float(r.duration_seconds or 0),
        "person_count": int(r.person_count or 0),
        "detection_source": str(r.detection_source or ""),
    }


def _recent_clips_with_uc2(scope: TenantScope, limit: int) -> list[int]:
    """Return up to ``limit`` recent clip IDs that have at least one
    existing UC2 row (so the comparison has something to baseline)."""
    engine = get_engine()
    with tenant_context(scope.tenant_schema):
        with engine.begin() as conn:
            rows = conn.execute(
                select(face_crops.c.person_clip_id)
                .where(face_crops.c.tenant_id == scope.tenant_id)
                .where(face_crops.c.use_case == "uc2")
                .group_by(face_crops.c.person_clip_id)
                .order_by(desc(face_crops.c.person_clip_id))
                .limit(limit)
            ).fetchall()
    return [int(r.person_clip_id) for r in rows]


def _render_html(
    output_dir: Path,
    rendered_clips: list[dict],
    schema: str,
) -> Path:
    """Generate the side-by-side comparison report."""
    css = """
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --border: #334155;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --good: #22c55e;
      --warn: #f59e0b;
    }
    * { box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 20px 28px; max-width: 1600px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px 0; }
    .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
    .clip { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px 22px; margin-bottom: 22px; }
    .clip-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
    .clip-id { font-size: 17px; font-weight: 700; }
    .clip-meta { color: var(--muted); font-size: 12px; }
    .clip-meta span { margin-right: 14px; }
    .row-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .col { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
    .col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .col-label { font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 999px; }
    .col-label.old { background: rgba(245,158,11,0.18); color: var(--warn); }
    .col-label.new { background: rgba(34,197,94,0.18); color: var(--good); }
    .col-count { font-size: 12px; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .tile { background: #0b1220; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; cursor: pointer; }
    .tile img { width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; }
    .tile .meta { padding: 6px 8px; font-size: 11px; line-height: 1.4; }
    .meta .row1 { color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta .row2 { color: var(--muted); font-variant-numeric: tabular-nums; }
    .empty { color: var(--muted); font-size: 13px; padding: 20px 8px; text-align: center; font-style: italic; }
    .stats { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; font-size: 11px; }
    .stat { background: rgba(255,255,255,0.04); padding: 6px 10px; border-radius: 6px; color: var(--muted); }
    .stat strong { color: var(--text); font-weight: 700; margin-left: 4px; font-variant-numeric: tabular-nums; }
    .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 100; padding: 30px; }
    .lightbox.open { display: flex; }
    .lightbox img { max-width: 92vw; max-height: 88vh; border-radius: 8px; box-shadow: 0 16px 48px rgba(0,0,0,0.6); }
    .lightbox .close { position: absolute; top: 20px; right: 28px; color: #fff; font-size: 32px; cursor: pointer; background: none; border: none; }
    """

    def _avg(values: list[float]) -> Optional[float]:
        if not values:
            return None
        return sum(values) / len(values)

    body_parts: list[str] = []
    for c in rendered_clips:
        old = c["old"]
        new = c["new"]
        old_count = len(old)
        new_count = len(new)
        old_q = _avg([s["quality_score"] for s in old])
        new_q = _avg([s["quality_score"] for s in new])
        old_match = sum(1 for s in old if s["employee_id"] is not None)
        new_match = sum(1 for s in new if s["employee_id"] is not None)
        old_dims = sorted({(s["width"], s["height"]) for s in old})
        new_dims = sorted({(s["width"], s["height"]) for s in new})

        def _tiles(folder: str, items: list[dict]) -> str:
            if not items:
                return '<div class="empty">No crops</div>'
            tiles = []
            for s in items:
                emp = (
                    f'emp #{s["employee_id"]}'
                    if s["employee_id"] is not None
                    else "Unknown"
                )
                q = int(round(s["quality_score"] * 100))
                ds = s["detection_score"]
                src = f'{folder}/{s["filename"]}'
                tiles.append(
                    f'<div class="tile" data-full="{src}">'
                    f'<img src="{src}" alt="">'
                    f'<div class="meta">'
                    f'<div class="row1">{emp}</div>'
                    f'<div class="row2">q={q} · det={ds:.2f} · {s["width"]}×{s["height"]}</div>'
                    f"</div></div>"
                )
            return f'<div class="grid">{"".join(tiles)}</div>'

        meta = c["meta"]
        dur = meta["duration_seconds"]
        body_parts.append(
            f"""
            <div class="clip">
              <div class="clip-head">
                <div class="clip-id">Clip #{meta['id']}</div>
                <div class="clip-meta">
                  <span>Camera {meta['camera_id']}</span>
                  <span>{meta['clip_start']}</span>
                  <span>{dur:.1f}s</span>
                  <span>{meta['person_count']} person(s) detected</span>
                  <span>source: {meta['detection_source']}</span>
                </div>
              </div>
              <div class="row-pair">
                <div class="col">
                  <div class="col-head">
                    <span class="col-label old">OLD (pre-refactor)</span>
                    <span class="col-count">{old_count} crop(s)</span>
                  </div>
                  {_tiles(f'clip_{meta["id"]}/old', old)}
                  <div class="stats">
                    <div class="stat">avg quality<strong>{(int(round((old_q or 0)*100)))}</strong></div>
                    <div class="stat">matched<strong>{old_match}/{old_count}</strong></div>
                    <div class="stat">dims<strong>{', '.join(f'{w}×{h}' for w, h in old_dims) or '—'}</strong></div>
                  </div>
                </div>
                <div class="col">
                  <div class="col-head">
                    <span class="col-label new">NEW (reference-parity)</span>
                    <span class="col-count">{new_count} crop(s)</span>
                  </div>
                  {_tiles(f'clip_{meta["id"]}/new', new)}
                  <div class="stats">
                    <div class="stat">avg quality<strong>{(int(round((new_q or 0)*100)))}</strong></div>
                    <div class="stat">matched<strong>{new_match}/{new_count}</strong></div>
                    <div class="stat">dims<strong>{', '.join(f'{w}×{h}' for w, h in new_dims) or '—'}</strong></div>
                  </div>
                </div>
              </div>
            </div>
            """
        )

    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>UC2 Comparison — {schema}</title>
  <style>{css}</style>
</head>
<body>
  <h1>UC2 — Old vs New crop comparison</h1>
  <div class="subtitle">
    Tenant: <strong>{schema}</strong> &middot;
    Generated: {datetime.now(timezone.utc).isoformat(timespec="seconds")} &middot;
    Clips: {len(rendered_clips)}
  </div>
  {''.join(body_parts) if body_parts else '<p>No clips to compare.</p>'}
  <div class="lightbox" id="lightbox">
    <button class="close" onclick="document.getElementById('lightbox').classList.remove('open')">×</button>
    <img id="lightbox-img" src="" alt="">
  </div>
  <script>
    document.querySelectorAll('.tile').forEach(el => {{
      el.addEventListener('click', () => {{
        const src = el.getAttribute('data-full');
        const lb = document.getElementById('lightbox');
        document.getElementById('lightbox-img').src = src;
        lb.classList.add('open');
      }});
    }});
    document.getElementById('lightbox').addEventListener('click', (e) => {{
      if (e.target.id === 'lightbox') e.currentTarget.classList.remove('open');
    }});
    document.addEventListener('keydown', (e) => {{
      if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
    }});
  </script>
</body>
</html>
"""

    index_path = output_dir / "index.html"
    index_path.write_text(html, encoding="utf-8")
    return index_path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--schema",
        required=True,
        help="Tenant schema name (e.g. tenant_inaisys or main).",
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--clip",
        type=int,
        nargs="+",
        help="Specific clip ID(s) to compare.",
    )
    g.add_argument(
        "--recent",
        type=int,
        metavar="N",
        help="Auto-pick N most recent clips that have UC2 history.",
    )
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    tenant_id = _resolve_tenant_id(args.schema)
    scope = TenantScope(tenant_id=tenant_id, tenant_schema=args.schema)

    if args.recent:
        clip_ids = _recent_clips_with_uc2(scope, args.recent)
        if not clip_ids:
            print("no clips with UC2 history on this tenant.", file=sys.stderr)
            sys.exit(1)
    else:
        clip_ids = list(args.clip)

    run_ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    output_dir = COMPARISON_ROOT / f"{args.schema}_{run_ts}"
    output_dir.mkdir(parents=True, exist_ok=True)
    logger.info("comparison root: %s", output_dir)

    rendered: list[dict] = []
    for clip_id in clip_ids:
        meta = _fetch_clip_meta(scope, clip_id)
        if meta is None:
            logger.warning("clip %s not found on tenant %s", clip_id, args.schema)
            continue

        clip_dir = output_dir / f"clip_{clip_id}"
        clip_dir.mkdir(parents=True, exist_ok=True)

        # 1. Snapshot existing UC2 crops as "old".
        old = _snapshot_crops(scope, clip_id, "uc2", clip_dir / "old")
        if not old:
            logger.warning(
                "clip %s has no UC2 crops on disk to snapshot — skipping",
                clip_id,
            )
            continue
        logger.info("clip %s: snapshotted %d old crop(s)", clip_id, len(old))

        # 2. Re-tag old rows as legacy so the new run doesn't co-mingle.
        flipped = _reflag_legacy(scope, clip_id)
        logger.info("clip %s: re-tagged %d row(s) to uc2_legacy", clip_id, flipped)

        # 3. Run UC2 with the new code.
        run_start = datetime.now(timezone.utc)
        logger.info("clip %s: running UC2 with new pipeline…", clip_id)
        process_single_clip(clip_id=clip_id, scope=scope, use_cases=("uc2",))

        # 4. Snapshot only the newly-created rows.
        new = _snapshot_crops(
            scope, clip_id, "uc2", clip_dir / "new",
            only_created_after=run_start,
        )
        logger.info("clip %s: snapshotted %d new crop(s)", clip_id, len(new))

        rendered.append({"meta": meta, "old": old, "new": new})

    if not rendered:
        print("nothing to render — no eligible clips.", file=sys.stderr)
        sys.exit(1)

    index = _render_html(output_dir, rendered, args.schema)
    print(f"\n✓ Comparison report:\n  {index}\n")
    print(
        "Open the HTML directly in your browser — on the host it's at:\n"
        f"  ./data/face_crops/_comparisons/{output_dir.name}/index.html\n"
    )


if __name__ == "__main__":
    main()
