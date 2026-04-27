"""
identify.py — match unidentified events against the known-people database.

Per-photo matching (Round 3):
  Each known person can have many reference photos (front, left profile,
  right profile, etc.). We store one embedding per photo and, when matching
  an event, we find the best (photo, event-face) pair per person.

Algorithm per event:
  1. Stack all event face embeddings → E  (F, 512)
  2. Stack all known-photo embeddings → K  (P, 512) with names_per_row of length P
  3. Similarity matrix S = E @ K.T   shape (F, P)
  4. For each known person N, pull the sub-columns of S belonging to their photos
     and compute:
        max_sim_N  = max over (face, photo) pairs
        mean_sim_N = mean over (face, photo) pairs
  5. Pick the person with the highest max_sim.
  6. Accept the match if max_sim >= MAX_THRESHOLD and mean_sim >= MEAN_THRESHOLD.
     (Strict dual — consistent matching AND at least one very confident pair.)
"""

import argparse
import numpy as np
import time
from typing import Optional

from db import init_db, get_conn
from known_people import cache as known_cache


# Cosine similarity thresholds between L2-normalized InsightFace embeddings.
# Slightly relaxed MEAN threshold because per-photo matching already gives us
# the strictness benefit (we take the best pair, not a mushy average).
MAX_THRESHOLD = 0.60     # at least one (face, photo) pair must exceed this
MEAN_THRESHOLD = 0.42    # average across all (face, photo) pairs for this person


def _blob_to_vec(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def identify_events(
    date: Optional[str] = None,
    reidentify: bool = False,
    progress_cb=None,
) -> dict:
    """Run identification across events."""
    init_db()

    reload_stats = known_cache.reload()
    known_matrix, names_per_row = known_cache.get_all_embeddings()
    if known_matrix.shape[0] == 0:
        return {
            "ok": False,
            "error": "no known people enrolled — add photos to known_people/<n>/",
            "processed": 0, "matched": 0, "unknown": 0,
            "reload": reload_stats,
        }

    # name -> column indices in known_matrix
    name_to_cols: dict[str, list[int]] = {}
    for i, name in enumerate(names_per_row):
        name_to_cols.setdefault(name, []).append(i)
    unique_names = list(name_to_cols.keys())

    where, params = [], []
    if not reidentify:
        where.append("person_name IS NULL")
    if date:
        where.append("date = ?")
        params.append(date)
    where.append("faces_saved > 0")

    sql = "SELECT id FROM events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id"

    t0 = time.time()
    processed = matched = unknown = 0

    with get_conn() as conn:
        event_ids = [row["id"] for row in conn.execute(sql, params).fetchall()]

        for eid in event_ids:
            faces = conn.execute(
                "SELECT embedding FROM faces WHERE event_id = ? AND embedding IS NOT NULL",
                (eid,),
            ).fetchall()
            if not faces:
                conn.execute(
                    "UPDATE events SET person_name = NULL, match_score = NULL WHERE id = ?",
                    (eid,),
                )
                unknown += 1; processed += 1
                continue

            face_matrix = np.stack([_blob_to_vec(r["embedding"]) for r in faces])
            # (F, 512) @ (P, 512).T -> (F, P)
            sims = face_matrix @ known_matrix.T

            best_person = None
            best_max = -1.0
            best_mean = -1.0
            for name in unique_names:
                cols = name_to_cols[name]
                sub = sims[:, cols]             # (F, photos_for_this_person)
                mx = float(sub.max())
                mn = float(sub.mean())
                if mx > best_max:
                    best_person, best_max, best_mean = name, mx, mn

            if best_max >= MAX_THRESHOLD and best_mean >= MEAN_THRESHOLD:
                conn.execute(
                    "UPDATE events SET person_name = ?, match_score = ? WHERE id = ?",
                    (best_person, best_max, eid),
                )
                matched += 1
            else:
                conn.execute(
                    "UPDATE events SET person_name = NULL, match_score = ? WHERE id = ?",
                    (best_max, eid),
                )
                unknown += 1

            processed += 1
            if processed % 50 == 0:
                conn.commit()
                if progress_cb:
                    progress_cb(processed, matched, unknown)

    elapsed = time.time() - t0
    return {
        "ok": True,
        "processed": processed,
        "matched": matched,
        "unknown": unknown,
        "elapsed_sec": round(elapsed, 2),
        "known_people": len(unique_names),
        "total_reference_photos": known_matrix.shape[0],
        "reload": reload_stats,
    }


# ---------------------------------------------------------------
# CLI
# ---------------------------------------------------------------
def _cli():
    p = argparse.ArgumentParser(description="Identify events against known people")
    p.add_argument("--date", help="restrict to this date (YYYY-MM-DD)")
    p.add_argument("--reidentify", action="store_true")
    args = p.parse_args()

    def progress(done, matched, unknown):
        print(f"  processed {done}  matched {matched}  unknown {unknown}")

    result = identify_events(
        date=args.date, reidentify=args.reidentify, progress_cb=progress,
    )
    if not result["ok"]:
        print("ERROR:", result["error"])
        return
    print(f"\n[done] {result['processed']} events in {result['elapsed_sec']}s")
    print(f"       {result['known_people']} people, "
          f"{result['total_reference_photos']} reference photos")
    print(f"       matched: {result['matched']}   unknown: {result['unknown']}")


if __name__ == "__main__":
    _cli()