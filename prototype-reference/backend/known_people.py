"""
known_people.py — known-person enrollment and embedding cache.

On-disk layout:
    known_people/
      Alice/
        ref_1.jpg       (front)
        ref_2.jpg       (left profile)
        ref_3.jpg       (right profile)
      Bob/
        ref_1.jpg

The module scans the folder, computes one embedding per reference photo
using InsightFace, and stores ALL of them for matching (not averaged).

Per-photo embeddings (vs. averaging) let a side-profile capture match the
side-profile reference precisely and a frontal capture match the frontal
reference precisely. Averaging would produce a "canonical" embedding that
matches all poses mediocrely but none perfectly. Matching cost is
negligible at any reasonable enrollment size (< ~1000 reference photos).

Call reload() after adding/removing photos so the cache picks up changes.
"""

import threading
import numpy as np
import cv2
from pathlib import Path
from typing import Optional

from detectors import _load_face_app   # reuse the same InsightFace instance


KNOWN_DIR = Path("known_people")
KNOWN_DIR.mkdir(exist_ok=True)

IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


class KnownPeopleCache:
    """Thread-safe cache of per-photo embeddings.

    Stores for each person a (n_photos, 512) matrix of L2-normalized embeddings.
    Matching against an event's faces is a single matrix multiply.
    """

    def __init__(self):
        self._lock = threading.RLock()
        # name -> dict(
        #   matrix=np.ndarray (n_photos, 512),   -- L2-normalized rows
        #   n_photos=int,
        #   photos=list[str],                    -- filenames in same order as matrix rows
        # )
        self._entries: dict[str, dict] = {}
        self._loaded = False

    def reload(self) -> dict:
        """Rescan the folder and recompute all embeddings. Returns stats."""
        face_app = _load_face_app()
        new_entries = {}
        skipped = []

        for person_dir in sorted(p for p in KNOWN_DIR.iterdir() if p.is_dir()):
            name = person_dir.name
            embeddings = []
            photos = []
            for img_path in sorted(person_dir.iterdir()):
                if img_path.suffix.lower() not in IMAGE_EXTS:
                    continue
                img = cv2.imread(str(img_path))
                if img is None:
                    skipped.append(f"{name}/{img_path.name} (unreadable)")
                    continue
                faces = face_app.get(img)
                if not faces:
                    skipped.append(f"{name}/{img_path.name} (no face)")
                    continue
                # Pick the biggest face if reference photo has more than one
                faces.sort(
                    key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                    reverse=True,
                )
                emb = np.asarray(faces[0].normed_embedding, dtype=np.float32)
                embeddings.append(emb)
                photos.append(img_path.name)

            if embeddings:
                matrix = np.stack(embeddings).astype(np.float32)
                # Re-normalize rows just in case (InsightFace already does, but cheap insurance)
                norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9
                matrix = matrix / norms
                new_entries[name] = {
                    "matrix": matrix,
                    "n_photos": len(photos),
                    "photos": photos,
                }

        with self._lock:
            self._entries = new_entries
            self._loaded = True
        return {"people": len(new_entries), "skipped": skipped}

    def ensure_loaded(self):
        if not self._loaded:
            self.reload()

    def list_people(self) -> list[dict]:
        """Returns [{name, n_photos, photos:[filenames], embedded:bool}]."""
        out = []
        for person_dir in sorted(p for p in KNOWN_DIR.iterdir() if p.is_dir()):
            photos = sorted(
                p.name for p in person_dir.iterdir()
                if p.suffix.lower() in IMAGE_EXTS
            )
            with self._lock:
                entry = self._entries.get(person_dir.name)
            out.append({
                "name": person_dir.name,
                "n_photos": len(photos),
                "photos": photos,
                "embedded": entry is not None and entry["n_photos"] == len(photos),
            })
        return out

    def get_all_embeddings(self) -> tuple[np.ndarray, list[str]]:
        """
        Stack every known-person-photo embedding into a single (TotalPhotos, 512)
        matrix. Returns (matrix, names_per_row) where names_per_row[i] tells us
        which person row i belongs to.

        This lets identify.py do one matmul and then group by name to find the
        best score per person.
        """
        self.ensure_loaded()
        with self._lock:
            items = list(self._entries.items())
        if not items:
            return np.zeros((0, 512), dtype=np.float32), []
        matrices = [entry["matrix"] for _, entry in items]
        names_per_row = []
        for name, entry in items:
            names_per_row.extend([name] * entry["n_photos"])
        matrix = np.vstack(matrices).astype(np.float32)
        return matrix, names_per_row

    def count(self) -> int:
        with self._lock:
            return len(self._entries)


# Module-level singleton
cache = KnownPeopleCache()


# ---------------------------------------------------------------
# Helpers for the HTTP routes (unchanged from Round 2)
# ---------------------------------------------------------------
def _safe_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ValueError("name cannot be empty")
    if any(c in name for c in '/\\:*?"<>|'):
        raise ValueError("name contains invalid characters")
    if name.startswith(".") or name in (".", ".."):
        raise ValueError("invalid name")
    return name


def person_dir(name: str) -> Path:
    return KNOWN_DIR / _safe_name(name)


def save_photo(name: str, file_bytes: bytes, original_filename: str) -> Path:
    pdir = person_dir(name)
    pdir.mkdir(parents=True, exist_ok=True)
    original = Path(original_filename).name
    ext = Path(original).suffix.lower()
    if ext not in IMAGE_EXTS:
        ext = ".jpg"
    base = Path(original).stem[:50] or "photo"
    candidate = pdir / f"{base}{ext}"
    i = 1
    while candidate.exists():
        candidate = pdir / f"{base}_{i}{ext}"
        i += 1
    candidate.write_bytes(file_bytes)
    return candidate


def delete_person(name: str) -> int:
    pdir = person_dir(name)
    if not pdir.exists():
        return 0
    count = 0
    for f in pdir.iterdir():
        try:
            f.unlink()
            count += 1
        except OSError:
            pass
    try:
        pdir.rmdir()
    except OSError:
        pass
    return count


def delete_photo(name: str, filename: str) -> bool:
    pdir = person_dir(name)
    if "/" in filename or "\\" in filename or ".." in filename:
        raise ValueError("invalid filename")
    target = pdir / filename
    if not target.exists() or not target.is_file():
        return False
    target.unlink()
    return True