"""In-memory matcher cache.

Maps ``employee_id`` → list of per-angle L2-normalised embeddings for
the pilot tenant. On each capture event the matcher picks the best
employee by cosine similarity, and only returns a match if the score
clears ``HADIR_MATCH_THRESHOLD`` — the threshold is **hard** (per
pilot-plan red lines), never advisory.

Scoring rule (pilot-plan P9):

    score(employee) = mean-of-top-k  over the employee's angle embeddings
    k = 1 for pilot — i.e. "use the best-matching angle per employee".

Cache invalidation is surgical. When a photo is added/removed/approved
we only reload that employee's row, not the whole tenant.
"""

from __future__ import annotations

import heapq
import logging
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np
from sqlalchemy import select

from hadir.config import get_settings
from hadir.db import employee_photos, get_engine
from hadir.identification.embeddings import decrypt_embedding
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Top-N similarities we keep per match call to power the DEBUG log the
# pilot-plan asks for ("log the top-3 matches per event at DEBUG so you
# can eyeball the distribution").
_TOP_N_DEBUG = 3


@dataclass(frozen=True, slots=True)
class Match:
    """What the matcher returns to the event emitter."""

    employee_id: int
    score: float  # mean-of-top-k cosine similarity


class MatcherCache:
    """Thread-safe per-tenant enrolled-embedding cache.

    Pilot is single-tenant, but the API already accepts a TenantScope so
    v1.0's multi-tenant cut-over is additive. Under the hood we keep
    one dict per tenant_id.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # tenant_id → {employee_id → stacked (N, 512) ndarray or None}.
        # None means "pending reload on next use".
        self._per_tenant: dict[int, dict[int, Optional[np.ndarray]]] = {}
        self._loaded: set[int] = set()

    # ------------------------------------------------------------------

    def invalidate_employee(self, employee_id: int) -> None:
        """Mark one employee's entry dirty so it reloads on next match."""

        with self._lock:
            for entries in self._per_tenant.values():
                if employee_id in entries:
                    entries[employee_id] = None

    def invalidate_all(self) -> None:
        """Force a full reload on next use. Pilot admin operations only."""

        with self._lock:
            self._per_tenant.clear()
            self._loaded.clear()

    # ------------------------------------------------------------------

    def _ensure_loaded(self, scope: TenantScope) -> dict[int, Optional[np.ndarray]]:
        with self._lock:
            entries = self._per_tenant.get(scope.tenant_id)
            if entries is not None and scope.tenant_id in self._loaded:
                # Already populated; just heal any per-employee invalidations.
                for emp_id, stacked in list(entries.items()):
                    if stacked is None:
                        entries[emp_id] = self._fetch_stack(scope, emp_id)
                return entries

            entries = self._full_load(scope)
            self._per_tenant[scope.tenant_id] = entries
            self._loaded.add(scope.tenant_id)
            logger.info(
                "matcher cache loaded: tenant_id=%s employees=%d vectors=%d",
                scope.tenant_id,
                len(entries),
                sum(s.shape[0] for s in entries.values() if s is not None),
            )
            return entries

    def _full_load(self, scope: TenantScope) -> dict[int, Optional[np.ndarray]]:
        engine = get_engine()
        by_emp: dict[int, list[np.ndarray]] = {}
        with engine.begin() as conn:
            rows = conn.execute(
                select(
                    employee_photos.c.employee_id,
                    employee_photos.c.embedding,
                ).where(
                    employee_photos.c.tenant_id == scope.tenant_id,
                    employee_photos.c.embedding.is_not(None),
                )
            ).all()
        for r in rows:
            try:
                vec = decrypt_embedding(bytes(r.embedding))
            except RuntimeError:
                logger.warning(
                    "matcher: could not decrypt embedding for employee %s",
                    r.employee_id,
                )
                continue
            by_emp.setdefault(int(r.employee_id), []).append(vec)

        return {
            emp_id: np.stack(vecs, axis=0) if vecs else None
            for emp_id, vecs in by_emp.items()
        }

    def _fetch_stack(
        self, scope: TenantScope, employee_id: int
    ) -> Optional[np.ndarray]:
        engine = get_engine()
        with engine.begin() as conn:
            rows = conn.execute(
                select(employee_photos.c.embedding).where(
                    employee_photos.c.tenant_id == scope.tenant_id,
                    employee_photos.c.employee_id == employee_id,
                    employee_photos.c.embedding.is_not(None),
                )
            ).all()
        vectors: list[np.ndarray] = []
        for r in rows:
            try:
                vectors.append(decrypt_embedding(bytes(r.embedding)))
            except RuntimeError:
                continue
        return np.stack(vectors, axis=0) if vectors else None

    # ------------------------------------------------------------------

    def match(
        self,
        scope: TenantScope,
        probe: np.ndarray,
        *,
        threshold: Optional[float] = None,
        top_k: int = 1,
    ) -> Optional[Match]:
        """Return the best employee for ``probe``, or None if none clear threshold."""

        if probe is None:
            return None
        probe = np.asarray(probe, dtype=np.float32).reshape(-1)
        if probe.shape[0] == 0:
            return None

        threshold = (
            threshold
            if threshold is not None
            else get_settings().match_threshold
        )

        entries = self._ensure_loaded(scope)
        if not entries:
            logger.debug("matcher: cache empty for tenant %s", scope.tenant_id)
            return None

        # Per-employee aggregated score = mean of top-k angle similarities.
        ranked: list[tuple[float, int]] = []
        for emp_id, stacked in entries.items():
            if stacked is None:
                continue
            # Both sides already L2-normalised, so cosine similarity is
            # just the dot product.
            sims = stacked @ probe  # shape (N,)
            k = max(1, min(top_k, sims.shape[0]))
            top = np.partition(sims, -k)[-k:]
            ranked.append((float(np.mean(top)), emp_id))

        if not ranked:
            return None
        ranked.sort(key=lambda t: t[0], reverse=True)

        # Pilot threshold tuning aid (pilot-plan P9): log the top-3 so an
        # operator can see the distribution per event.
        if logger.isEnabledFor(logging.DEBUG):
            top3 = heapq.nlargest(_TOP_N_DEBUG, ranked, key=lambda t: t[0])
            logger.debug(
                "matcher top%d: %s (threshold=%.3f)",
                _TOP_N_DEBUG,
                [(eid, round(s, 3)) for s, eid in top3],
                threshold,
            )

        best_score, best_emp = ranked[0]
        if best_score < threshold:
            return None
        return Match(employee_id=best_emp, score=best_score)


matcher_cache = MatcherCache()
