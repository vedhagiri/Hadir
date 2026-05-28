"""Backfill ``detection_events.embedding`` for rows that have a crop on
disk but no embedding stored.

Why this exists
---------------
The clip-pipeline reprocess flow (``maugood/person_clips/reprocess.py``)
used to fan out into ``detection_events`` without copying / computing an
embedding for the row.  Result: every recent unidentified detection
landed with ``embedding IS NULL``, and Unidentified Faces → Similarity
Groups had nothing to cluster.

Migration 0066 + reprocess.py fix the forward path (embedding is stored
on ``face_crops`` at extract time and copied on fan-out).  This script
recovers the historical gap by:

1. Selecting every ``detection_events`` row with
   ``embedding IS NULL AND face_crop_path IS NOT NULL`` (per tenant).
2. Reading the encrypted JPEG from disk and decrypting it.
3. Running InsightFace recognition on the crop to produce a 512-float32
   L2-normalised vector.
4. Fernet-encrypting the vector and UPDATEing the row.

What gets skipped (and why each is safe)
----------------------------------------
* Missing file on disk             — orphan crop; nothing we can do here.
* Encrypted-blob decrypt failure   — wrong key or corrupted bytes; the
                                     row stays NULL and the operator
                                     can investigate via the audit log.
* InsightFace finds 0 faces        — the crop is too low-quality or
                                     contains no detectable face; the
                                     row stays NULL and won't cluster
                                     (which is correct — clustering
                                     a non-face would be noise).

Usage
-----
* Dry run (default — no UPDATEs, just counts):
    docker compose exec backend python -m scripts.backfill_detection_event_embeddings
* Apply for one tenant:
    docker compose exec backend python -m scripts.backfill_detection_event_embeddings \
        --apply --tenant <slug>
* Apply for every active tenant:
    docker compose exec backend python -m scripts.backfill_detection_event_embeddings --apply

The script is **idempotent**: it only touches rows where
``embedding IS NULL``, and on every UPDATE the new value is set, so
re-running is a no-op (unless new gaps have accumulated).
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Iterable

import cv2  # type: ignore[import-untyped]
import numpy as np
from sqlalchemy import select, text, update

from maugood.capture.analyzer import get_analyzer
from maugood.db import detection_events, get_engine, tenant_context
from maugood.employees.photos import decrypt_bytes
from maugood.identification.embeddings import encrypt_embedding

logger = logging.getLogger("backfill_embeddings")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _list_active_tenants() -> list[tuple[int, str, str]]:
    """Return ``(id, slug, schema_name)`` for every active tenant."""
    with tenant_context("public"):
        with get_engine().begin() as conn:
            rows = conn.execute(
                text(
                    "SELECT id, slug, schema_name FROM tenants "
                    "WHERE status = 'active' ORDER BY id"
                )
            ).all()
    return [(int(r.id), str(r.slug), str(r.schema_name)) for r in rows]


def _candidate_rows(conn, batch_size: int) -> list:  # type: ignore[no-untyped-def]
    """Pull the next batch of detection_events that need an embedding.

    Ordered by id desc so we catch the most-recent gap first — that's
    what the Unidentified Faces page is showing the operator.
    """
    return conn.execute(
        select(
            detection_events.c.id,
            detection_events.c.face_crop_path,
        )
        .where(
            detection_events.c.embedding.is_(None),
            detection_events.c.face_crop_path.isnot(None),
        )
        .order_by(detection_events.c.id.desc())
        .limit(batch_size)
        .offset(0)
    ).all()


def _embed_one(path_str: str) -> tuple[str, np.ndarray | None]:
    """Decrypt + run InsightFace on a single on-disk crop.

    Returns ``("ok", vec)`` on success, ``("missing", None)`` if the
    file isn't on disk, ``("decrypt_failed", None)`` if Fernet rejects
    the bytes, ``("decode_failed", None)`` if cv2 can't parse the
    JPEG, ``("no_face", None)`` if InsightFace finds nothing, and
    ``("error", None)`` for any other unexpected failure.
    """
    crop_path = Path(path_str)
    if not crop_path.exists():
        return "missing", None
    try:
        encrypted = crop_path.read_bytes()
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
        analyzer = get_analyzer()
        emb = analyzer.embed_crop(img)
    except Exception as exc:  # noqa: BLE001
        logger.debug("embed_crop raised: %s", type(exc).__name__)
        return "error", None
    if emb is None:
        return "no_face", None
    return "ok", np.asarray(emb, dtype=np.float32)


def _process_tenant(
    *,
    tenant_id: int,
    slug: str,
    schema: str,
    apply: bool,
    batch_size: int,
    max_rows: int | None,
) -> dict[str, int]:
    """Run the backfill against one tenant schema.

    Returns a dict of counters for the summary line.
    """
    counts = {
        "scanned": 0,
        "embedded": 0,
        "missing": 0,
        "decrypt_failed": 0,
        "decode_failed": 0,
        "no_face": 0,
        "error": 0,
    }

    with tenant_context(schema):
        # Total candidate count up front so the progress line is
        # informative.  Two engine calls per batch is the cost of doing
        # the work inside per-row transactions (which keeps a single
        # bad crop from rolling back the whole batch).
        with get_engine().begin() as conn:
            total = conn.execute(
                select(detection_events.c.id)
                .where(
                    detection_events.c.embedding.is_(None),
                    detection_events.c.face_crop_path.isnot(None),
                )
            ).rowcount or 0
        if total == 0:
            print(f"  {slug}: no rows need backfill")
            return counts

        cap = total if max_rows is None else min(total, max_rows)
        print(f"  {slug}: {cap}/{total} rows to process "
              f"({'APPLY' if apply else 'dry-run'})")

        processed = 0
        # Each iteration grabs the next ``batch_size`` rows where
        # embedding is still NULL.  Because we UPDATE-to-non-NULL
        # within the loop, the next SELECT naturally advances —
        # there's no OFFSET drift and no risk of re-processing.
        while processed < cap:
            with get_engine().begin() as conn:
                rows = _candidate_rows(conn, batch_size=batch_size)
            if not rows:
                break
            for row in rows:
                if processed >= cap:
                    break
                counts["scanned"] += 1
                processed += 1

                status, vec = _embed_one(str(row.face_crop_path))
                if status != "ok":
                    counts[status] += 1
                    # In dry-run, surface the same skip codes the apply
                    # run would; rows that fail decrypt/decode in
                    # dry-run will fail the same way under --apply.
                    continue

                if not apply or vec is None:
                    counts["embedded"] += 1
                    continue

                try:
                    encrypted = encrypt_embedding(vec)
                except (RuntimeError, ValueError) as exc:
                    logger.debug(
                        "encrypt_embedding failed for id=%s: %s",
                        row.id, type(exc).__name__,
                    )
                    counts["error"] += 1
                    continue

                with get_engine().begin() as conn:
                    conn.execute(
                        update(detection_events)
                        .where(detection_events.c.id == int(row.id))
                        .values(embedding=encrypted)
                    )
                counts["embedded"] += 1

                if processed % 50 == 0:
                    print(f"    {slug}: {processed}/{cap}…")

    print(
        f"  {slug}: scanned={counts['scanned']} "
        f"embedded={counts['embedded']} "
        f"missing={counts['missing']} "
        f"decrypt_failed={counts['decrypt_failed']} "
        f"decode_failed={counts['decode_failed']} "
        f"no_face={counts['no_face']} "
        f"error={counts['error']}"
    )
    return counts


# --------------------------------------------------------------------------
# CLI entry point
# --------------------------------------------------------------------------


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill detection_events.embedding for rows that "
                    "have a face crop on disk but no embedding stored.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually UPDATE rows. Without --apply this is a dry run "
             "that reports counts only.",
    )
    parser.add_argument(
        "--tenant",
        type=str,
        default=None,
        help="Tenant slug (e.g. 'inaisys'). Defaults to every active tenant.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="Rows fetched per SELECT (default 100). Smaller = lower memory.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Stop after processing this many rows per tenant. "
             "Useful for first-pass smoke testing.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Bump log level to DEBUG.",
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
        f"Backfill detection_events.embedding "
        f"({'APPLY' if args.apply else 'DRY RUN'}) "
        f"across {len(tenants)} tenant(s)"
    )

    totals = {
        "scanned": 0,
        "embedded": 0,
        "missing": 0,
        "decrypt_failed": 0,
        "decode_failed": 0,
        "no_face": 0,
        "error": 0,
    }

    t0 = time.time()
    for tenant_id, slug, schema in tenants:
        sub = _process_tenant(
            tenant_id=tenant_id,
            slug=slug,
            schema=schema,
            apply=args.apply,
            batch_size=args.batch_size,
            max_rows=args.max_rows,
        )
        for k, v in sub.items():
            totals[k] += v

    elapsed = time.time() - t0
    print(
        f"\nDone in {elapsed:.1f}s — total: "
        f"scanned={totals['scanned']} "
        f"embedded={totals['embedded']} "
        f"missing={totals['missing']} "
        f"decrypt_failed={totals['decrypt_failed']} "
        f"decode_failed={totals['decode_failed']} "
        f"no_face={totals['no_face']} "
        f"error={totals['error']}"
    )
    if not args.apply:
        print(
            "(Dry run — re-run with --apply to actually persist the "
            "embeddings shown as 'embedded' above.)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
