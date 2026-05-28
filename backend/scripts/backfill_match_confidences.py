"""Backfill match_confidence on face_crops + detection_events.

Why this exists
---------------
``maugood/person_clips/reprocess.py`` had a long-standing bug: it read
``getattr(mm, "confidence", 0.0)`` on the ``Match`` dataclass, but the
field is actually called ``score`` — so the ``getattr`` fell through to
the default and every clip-pipeline crop landed with
``face_crops.match_confidence = 0.0``. The fan-out into
``detection_events`` copies that same value, so every UI surface
(Camera Logs, Clip Analytics, Unidentified Faces, Matched Clips,
Employee Camera Events) rendered ``0%``.

The bug is fixed forward by the ``getattr(..., "score", 0.0)`` swap in
``reprocess.py``. This script recovers the historical gap.

What it does
------------
Per tenant:

  Phase A — re-match every ``face_crops`` row that has an
            ``employee_id`` set but ``match_confidence`` is NULL or 0.
            Steps per row: decrypt the saved crop → run InsightFace
            recognition → call ``matcher_cache.match()`` → if the
            matcher returns a hit, UPDATE ``match_confidence`` with
            the returned ``score``. ``employee_id`` is left alone (we
            trust the existing attribution).

  Phase B — UPDATE ``detection_events.confidence`` from the corresponding
            ``face_crops.match_confidence``. Track_id encodes the
            mapping:

              clip-{cid}-emp-{eid}-in      → matching face_crops for
              clip-{cid}-emp-{eid}-out       this (clip, employee);
                                             take the row with the
                                             max match_confidence so
                                             a partial Phase-A recovery
                                             still surfaces the best
                                             available score.

              clip-{cid}-unk-{crop_id}     → face_crops.id = crop_id;
                                             unknown rows stay NULL by
                                             design (no employee match).

What it skips
-------------
* Crops whose file is missing on disk        — orphan.
* Decrypt / decode / InsightFace failures    — counted, row stays NULL.
* Crops the matcher refuses today (below     — counted as ``no_match``;
  ``MAUGOOD_MATCH_THRESHOLD``)                 row stays NULL.

Usage
-----
* Dry run (counts only, no UPDATEs):
    docker compose exec backend python -m scripts.backfill_match_confidences

* Apply for one tenant:
    docker compose exec backend python -m scripts.backfill_match_confidences \
        --apply --tenant <slug>

* Apply for every active tenant:
    docker compose exec backend python -m scripts.backfill_match_confidences --apply

Idempotent: only touches rows where the confidence column is NULL or
exactly 0; re-running is a no-op until new gaps land.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

import cv2  # type: ignore[import-untyped]
import numpy as np
from sqlalchemy import select, text, update

from maugood.capture.analyzer import get_analyzer
from maugood.db import (
    detection_events,
    face_crops,
    get_engine,
    tenant_context,
)
from maugood.employees.photos import decrypt_bytes
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

logger = logging.getLogger("backfill_match_confidences")


def _list_active_tenants() -> list[tuple[int, str, str]]:
    with tenant_context("public"):
        with get_engine().begin() as conn:
            rows = conn.execute(
                text(
                    "SELECT id, slug, schema_name FROM tenants "
                    "WHERE status = 'active' ORDER BY id"
                )
            ).all()
    return [(int(r.id), str(r.slug), str(r.schema_name)) for r in rows]


def _rematch_one(
    tenant_id: int,
    path_str: str,
    expected_employee_id: int,
) -> tuple[str, Optional[float]]:
    """Decrypt the crop, embed, match. Returns one of:

    * ("ok", score)              — matcher returned an active match;
                                   ``score`` is the cosine similarity.
    * ("ok_wrong_employee", s)   — matcher returned a different
                                   employee. The score is still useful
                                   (we trust the existing employee_id
                                   and persist the score anyway).
    * ("missing", None)          — file not on disk.
    * ("decrypt_failed", None)   — Fernet rejected.
    * ("decode_failed", None)    — cv2 imdecode failed.
    * ("no_face", None)          — InsightFace found nothing.
    * ("no_match", None)         — matcher returned None (below threshold).
    * ("error", None)            — anything else.
    """
    p = Path(path_str)
    if not p.exists():
        return "missing", None
    try:
        encrypted = p.read_bytes()
    except OSError:
        return "missing", None
    try:
        jpeg_bytes = decrypt_bytes(encrypted)
    except Exception:  # noqa: BLE001
        return "decrypt_failed", None
    try:
        arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception:  # noqa: BLE001
        return "decode_failed", None
    if img is None or getattr(img, "size", 0) == 0:
        return "decode_failed", None
    try:
        emb = get_analyzer().embed_crop(img)
    except Exception as exc:  # noqa: BLE001
        logger.debug("embed_crop failed: %s", type(exc).__name__)
        return "error", None
    if emb is None:
        return "no_face", None

    probe = np.asarray(emb, dtype=np.float32)
    scope = TenantScope(tenant_id=tenant_id)
    try:
        mm = matcher_cache.match(scope, probe)
    except Exception as exc:  # noqa: BLE001
        logger.debug("matcher_cache.match failed: %s", type(exc).__name__)
        return "error", None
    if mm is None or mm.classification != "active":
        return "no_match", None

    score = float(mm.score)
    if int(mm.employee_id) == int(expected_employee_id):
        return "ok", score
    return "ok_wrong_employee", score


def _phase_a_face_crops(
    *,
    tenant_id: int,
    slug: str,
    schema: str,
    apply: bool,
    batch_size: int,
    max_rows: Optional[int],
) -> dict[str, int]:
    counts = {
        "scanned": 0,
        "updated": 0,
        "missing": 0,
        "decrypt_failed": 0,
        "decode_failed": 0,
        "no_face": 0,
        "no_match": 0,
        "error": 0,
        "ok_wrong_employee": 0,
    }
    with tenant_context(schema):
        with get_engine().begin() as conn:
            total = conn.execute(
                text(
                    "SELECT COUNT(*) FROM face_crops "
                    "WHERE employee_id IS NOT NULL "
                    "  AND file_path IS NOT NULL "
                    "  AND (match_confidence IS NULL OR match_confidence = 0)"
                )
            ).scalar_one()
        if not total:
            print(f"  [Phase A] {slug}: no face_crops need backfill")
            return counts

        cap = total if max_rows is None else min(total, max_rows)
        print(f"  [Phase A] {slug}: {cap}/{total} face_crops "
              f"({'APPLY' if apply else 'dry-run'})")

        processed = 0
        while processed < cap:
            with get_engine().begin() as conn:
                rows = conn.execute(
                    select(
                        face_crops.c.id,
                        face_crops.c.file_path,
                        face_crops.c.employee_id,
                    )
                    .where(
                        face_crops.c.employee_id.isnot(None),
                        face_crops.c.file_path.isnot(None),
                        (
                            face_crops.c.match_confidence.is_(None)
                            | (face_crops.c.match_confidence == 0)
                        ),
                    )
                    .order_by(face_crops.c.id.desc())
                    .limit(batch_size)
                ).all()
            if not rows:
                break
            for row in rows:
                if processed >= cap:
                    break
                processed += 1
                counts["scanned"] += 1
                status, score = _rematch_one(
                    tenant_id,
                    str(row.file_path),
                    int(row.employee_id),
                )
                if status in ("missing", "decrypt_failed", "decode_failed",
                              "no_face", "no_match", "error"):
                    counts[status] += 1
                    continue
                # status is "ok" or "ok_wrong_employee" — both give a
                # usable score. The wrong-employee case is rare and
                # the operator's earlier attribution stands; we just
                # record the score so the UI stops showing 0%.
                if status == "ok_wrong_employee":
                    counts["ok_wrong_employee"] += 1
                if not apply or score is None:
                    counts["updated"] += 1
                    continue
                with get_engine().begin() as conn:
                    conn.execute(
                        update(face_crops)
                        .where(face_crops.c.id == int(row.id))
                        .values(match_confidence=float(score))
                    )
                counts["updated"] += 1
                if processed % 50 == 0:
                    print(f"    {slug}: {processed}/{cap}…")
    print(
        f"  [Phase A] {slug}: scanned={counts['scanned']} "
        f"updated={counts['updated']} "
        f"missing={counts['missing']} "
        f"decrypt_failed={counts['decrypt_failed']} "
        f"decode_failed={counts['decode_failed']} "
        f"no_face={counts['no_face']} "
        f"no_match={counts['no_match']} "
        f"wrong_emp={counts['ok_wrong_employee']} "
        f"error={counts['error']}"
    )
    return counts


def _phase_b_detection_events(
    *,
    slug: str,
    schema: str,
    apply: bool,
) -> dict[str, int]:
    """Refresh detection_events.confidence from face_crops via track_id.

    Two patterns are recoverable from face_crops:
      * ``clip-{cid}-emp-{eid}-in`` and
        ``clip-{cid}-emp-{eid}-out`` → take the max match_confidence
        for that (clip, employee) — safest pick now that the fan-out
        boundaries (first/last) are no longer reachable from a static
        SQL JOIN (the timestamps live in face_crops.event_timestamp
        which is a compact string, not a comparable type).
      * ``clip-{cid}-unk-{crop_id}`` → not applicable (unknown rows
        are unmatched by definition; ``confidence`` stays NULL).

    One bulk UPDATE per pattern keeps the DB load proportional to
    affected rows rather than per-row work.
    """
    counts = {"scanned": 0, "updated": 0}
    with tenant_context(schema):
        with get_engine().begin() as conn:
            scan = conn.execute(
                text(
                    "SELECT COUNT(*) FROM detection_events "
                    "WHERE (confidence IS NULL OR confidence = 0) "
                    "  AND employee_id IS NOT NULL "
                    "  AND track_id ~ '^clip-[0-9]+-emp-[0-9]+-(in|out)$'"
                )
            ).scalar_one()
            counts["scanned"] = int(scan)
        if not counts["scanned"]:
            print(f"  [Phase B] {slug}: no detection_events need backfill")
            return counts

        print(f"  [Phase B] {slug}: {counts['scanned']} rows "
              f"({'APPLY' if apply else 'dry-run'})")
        if not apply:
            counts["updated"] = counts["scanned"]
            return counts

        # Single SQL pass — regex-extract clip_id from the track_id
        # and join face_crops on (clip_id, employee_id). max() picks
        # the strongest available match score for that employee in
        # that clip.
        sql = text("""
            UPDATE detection_events de
            SET confidence = sub.best_score
            FROM (
              SELECT
                de2.id              AS de_id,
                MAX(fc.match_confidence) AS best_score
              FROM detection_events de2
              JOIN face_crops fc ON
                  fc.tenant_id      = de2.tenant_id
              AND fc.person_clip_id = (
                    substring(de2.track_id from '^clip-([0-9]+)-emp-')::int
                  )
              AND fc.employee_id    = de2.employee_id
              WHERE (de2.confidence IS NULL OR de2.confidence = 0)
                AND de2.employee_id IS NOT NULL
                AND de2.track_id ~ '^clip-[0-9]+-emp-[0-9]+-(in|out)$'
                AND fc.match_confidence IS NOT NULL
                AND fc.match_confidence > 0
              GROUP BY de2.id
            ) AS sub
            WHERE de.id = sub.de_id
        """)
        with get_engine().begin() as conn:
            result = conn.execute(sql)
            counts["updated"] = result.rowcount or 0
    print(f"  [Phase B] {slug}: updated={counts['updated']}")
    return counts


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill match_confidence on face_crops + "
                    "detection_events that were affected by the "
                    "reprocess.py confidence/score field-name bug.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually UPDATE rows. Without --apply this is dry-run.",
    )
    parser.add_argument(
        "--tenant",
        type=str,
        default=None,
        help="Tenant slug. Default: every active tenant.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="face_crops batch size for Phase A (default 100).",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Cap face_crops processed per tenant (Phase A only).",
    )
    parser.add_argument(
        "--skip-phase-a",
        action="store_true",
        help="Skip face_crops re-match. Useful when face_crops is "
             "already healed and only detection_events lags.",
    )
    parser.add_argument(
        "--skip-phase-b",
        action="store_true",
        help="Skip detection_events refresh. Useful for smoke testing "
             "Phase A in isolation.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="DEBUG-level logs.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    tenants = _list_active_tenants()
    if args.tenant:
        tenants = [t for t in tenants if t[1] == args.tenant]
        if not tenants:
            print(f"No active tenant matches slug={args.tenant!r}")
            return 1

    print(
        f"Backfill match_confidence "
        f"({'APPLY' if args.apply else 'DRY RUN'}) "
        f"across {len(tenants)} tenant(s)"
    )

    totals_a = {
        "scanned": 0, "updated": 0, "missing": 0,
        "decrypt_failed": 0, "decode_failed": 0,
        "no_face": 0, "no_match": 0, "error": 0,
        "ok_wrong_employee": 0,
    }
    totals_b = {"scanned": 0, "updated": 0}

    t0 = time.time()
    for tenant_id, slug, schema in tenants:
        if not args.skip_phase_a:
            sub = _phase_a_face_crops(
                tenant_id=tenant_id,
                slug=slug,
                schema=schema,
                apply=args.apply,
                batch_size=args.batch_size,
                max_rows=args.max_rows,
            )
            for k, v in sub.items():
                totals_a[k] += v
        if not args.skip_phase_b:
            sub = _phase_b_detection_events(
                slug=slug,
                schema=schema,
                apply=args.apply,
            )
            for k, v in sub.items():
                totals_b[k] += v

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")
    print(
        f"  Phase A totals: scanned={totals_a['scanned']} "
        f"updated={totals_a['updated']} "
        f"missing={totals_a['missing']} "
        f"decrypt={totals_a['decrypt_failed']} "
        f"decode={totals_a['decode_failed']} "
        f"no_face={totals_a['no_face']} "
        f"no_match={totals_a['no_match']} "
        f"wrong_emp={totals_a['ok_wrong_employee']} "
        f"error={totals_a['error']}"
    )
    print(
        f"  Phase B totals: scanned={totals_b['scanned']} "
        f"updated={totals_b['updated']}"
    )
    if not args.apply:
        print(
            "(Dry run — re-run with --apply to persist updates.)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
