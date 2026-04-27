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

P28.7 — the matcher classifies each match by the matched employee's
**lifecycle state**, computed from ``status`` + ``joining_date`` +
``relieving_date``:

* ``active``    — status='active' AND today is between joining_date
                  and relieving_date (NULL = no constraint).
                  → ``detection_events.employee_id`` set, attendance flows.
* ``inactive``  — status='inactive', OR status='active' but today is
                  past ``relieving_date`` (edge case: the cron hasn't
                  run yet but they've effectively left).
                  → ``former_employee_match=true`` + ``former_match_employee_id`` set.
                  → ``employee_id`` stays NULL so attendance queries
                  (filtering on ``employee_id IS NOT NULL``) skip this row.
* ``future``    — status='active' but today < ``joining_date``.
                  → Treat as Unknown — neither column populated.
                  → Lets HR pre-enroll a new hire's photos before they
                  start without leaking false-positives into attendance.
"""

from __future__ import annotations

import heapq
import logging
import threading
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo

import numpy as np
from sqlalchemy import select

from hadir.config import get_settings
from hadir.db import employee_photos, employees, get_engine
from hadir.identification.embeddings import decrypt_embedding
from hadir.tenants.scope import TenantScope

logger = logging.getLogger(__name__)

# Top-N similarities we keep per match call to power the DEBUG log the
# pilot-plan asks for ("log the top-3 matches per event at DEBUG so you
# can eyeball the distribution").
_TOP_N_DEBUG = 3


MatchClassification = Literal["active", "inactive", "future"]


@dataclass(frozen=True, slots=True)
class _EmployeeLifecycle:
    """The lifecycle inputs the matcher needs per employee. Loaded at
    the same time as embeddings so the classification step is local."""

    status: str
    joining_date: Optional[date]
    relieving_date: Optional[date]
    employee_code: str
    full_name: str


@dataclass(frozen=True, slots=True)
class Match:
    """What the matcher returns to the event emitter.

    P28.7: ``classification`` carries the lifecycle decision so the
    event emitter knows which columns to populate. ``employee_code``
    + ``full_name`` are included for the INFO log on former-employee
    matches without forcing a second DB lookup.
    """

    employee_id: int
    score: float  # mean-of-top-k cosine similarity
    classification: MatchClassification = "active"
    employee_code: str = ""
    full_name: str = ""


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
        # P28.7: per-tenant lifecycle metadata loaded alongside embeddings.
        # tenant_id → {employee_id → _EmployeeLifecycle}.
        self._lifecycle: dict[int, dict[int, _EmployeeLifecycle]] = {}
        self._loaded: set[int] = set()

    # ------------------------------------------------------------------

    def invalidate_employee(self, employee_id: int) -> None:
        """Mark one employee's entry dirty so it reloads on next match.

        P28.7: invalidates BOTH the embedding cache and the lifecycle
        cache so a status flip (active ↔ inactive) reflects on the
        next detection without a full reload.
        """

        with self._lock:
            for entries in self._per_tenant.values():
                if employee_id in entries:
                    entries[employee_id] = None
            for life in self._lifecycle.values():
                life.pop(employee_id, None)

    def invalidate_all(self) -> None:
        """Force a full reload on next use. Pilot admin operations only."""

        with self._lock:
            self._per_tenant.clear()
            self._lifecycle.clear()
            self._loaded.clear()

    def invalidate_tenant(self, tenant_id: int) -> None:
        """Drop one tenant's entire cache. P28.7 lifecycle cron uses this
        after a batch of auto-deactivations so the next detection picks
        up the new statuses in a single reload."""

        with self._lock:
            self._per_tenant.pop(tenant_id, None)
            self._lifecycle.pop(tenant_id, None)
            self._loaded.discard(tenant_id)

    # ------------------------------------------------------------------

    def _ensure_loaded(self, scope: TenantScope) -> dict[int, Optional[np.ndarray]]:
        with self._lock:
            entries = self._per_tenant.get(scope.tenant_id)
            if entries is not None and scope.tenant_id in self._loaded:
                # Already populated; just heal any per-employee invalidations.
                for emp_id, stacked in list(entries.items()):
                    if stacked is None:
                        entries[emp_id] = self._fetch_stack(scope, emp_id)
                # P28.7: re-fetch lifecycle for any employee whose
                # entry was invalidated. Cheap — a single per-employee
                # row per missing entry, only fires after a status flip.
                lifecycle = self._lifecycle.setdefault(scope.tenant_id, {})
                for emp_id in entries:
                    if emp_id not in lifecycle:
                        info = self._fetch_lifecycle(scope, emp_id)
                        if info is not None:
                            lifecycle[emp_id] = info
                return entries

            entries, lifecycle = self._full_load(scope)
            self._per_tenant[scope.tenant_id] = entries
            self._lifecycle[scope.tenant_id] = lifecycle
            self._loaded.add(scope.tenant_id)
            logger.info(
                "matcher cache loaded: tenant_id=%s employees=%d vectors=%d",
                scope.tenant_id,
                len(entries),
                sum(s.shape[0] for s in entries.values() if s is not None),
            )
            return entries

    def _full_load(
        self, scope: TenantScope
    ) -> tuple[dict[int, Optional[np.ndarray]], dict[int, _EmployeeLifecycle]]:
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
            # P28.7: load lifecycle metadata for every employee that
            # has at least one embedding. Includes status, joining +
            # relieving dates, employee_code, full_name.
            emp_ids = {int(r.employee_id) for r in rows}
            lifecycle: dict[int, _EmployeeLifecycle] = {}
            if emp_ids:
                life_rows = conn.execute(
                    select(
                        employees.c.id,
                        employees.c.status,
                        employees.c.joining_date,
                        employees.c.relieving_date,
                        employees.c.employee_code,
                        employees.c.full_name,
                    ).where(
                        employees.c.tenant_id == scope.tenant_id,
                        employees.c.id.in_(list(emp_ids)),
                    )
                ).all()
                for er in life_rows:
                    lifecycle[int(er.id)] = _EmployeeLifecycle(
                        status=str(er.status),
                        joining_date=er.joining_date,
                        relieving_date=er.relieving_date,
                        employee_code=str(er.employee_code),
                        full_name=str(er.full_name),
                    )

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

        embeddings = {
            emp_id: np.stack(vecs, axis=0) if vecs else None
            for emp_id, vecs in by_emp.items()
        }
        return embeddings, lifecycle

    def _fetch_lifecycle(
        self, scope: TenantScope, employee_id: int
    ) -> Optional[_EmployeeLifecycle]:
        engine = get_engine()
        with engine.begin() as conn:
            row = conn.execute(
                select(
                    employees.c.status,
                    employees.c.joining_date,
                    employees.c.relieving_date,
                    employees.c.employee_code,
                    employees.c.full_name,
                ).where(
                    employees.c.tenant_id == scope.tenant_id,
                    employees.c.id == employee_id,
                )
            ).first()
        if row is None:
            return None
        return _EmployeeLifecycle(
            status=str(row.status),
            joining_date=row.joining_date,
            relieving_date=row.relieving_date,
            employee_code=str(row.employee_code),
            full_name=str(row.full_name),
        )

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
        """Return the best employee for ``probe``, or None if none clear threshold.

        P28.7: the returned ``Match`` is classified by lifecycle state.
        ``classification='future'`` is treated as "Unknown" by the caller
        — the prompt's locked decision: future joining_date matches do
        not get attendance and do not get the former-employee flag.
        """

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

        # P28.7: classify against lifecycle. Falls back to "active"
        # when the employee row vanished between cache load and now
        # (e.g. mid-flight hard-delete) — the caller's path safely
        # handles that as a normal active match against a stale id;
        # the next reload will drop the entry.
        lifecycle = self._lifecycle.get(scope.tenant_id, {}).get(best_emp)
        classification: MatchClassification = "active"
        emp_code = ""
        emp_name = ""
        if lifecycle is not None:
            emp_code = lifecycle.employee_code
            emp_name = lifecycle.full_name
            classification = self._classify(scope, lifecycle)

        return Match(
            employee_id=best_emp,
            score=best_score,
            classification=classification,
            employee_code=emp_code,
            full_name=emp_name,
        )

    @staticmethod
    def _classify(
        scope: TenantScope, info: _EmployeeLifecycle
    ) -> MatchClassification:
        """Decide active / inactive / future for a lifecycle entry.

        Uses the tenant's local timezone for the date comparison so a
        camera firing at 23:30 Asia/Muscat (= 19:30 UTC) on the day a
        relieving_date falls is judged against the tenant's wall clock,
        not the server's UTC clock.
        """

        try:
            from hadir.attendance.repository import (  # noqa: PLC0415
                load_tenant_settings,
                local_tz_for,
            )

            engine = get_engine()
            with engine.begin() as conn:
                settings = load_tenant_settings(conn, scope)
            today = datetime.now(timezone.utc).astimezone(
                local_tz_for(settings)
            ).date()
        except Exception:  # noqa: BLE001
            # Settings unavailable → fall back to UTC. The classification
            # is still correct in the bulk of cases.
            today = datetime.now(timezone.utc).date()

        if info.status != "active":
            return "inactive"
        if info.joining_date is not None and today < info.joining_date:
            return "future"
        if info.relieving_date is not None and today > info.relieving_date:
            # Edge case: cron hasn't run yet but the employee has
            # effectively left — treat as inactive so the next
            # detection routes to the security report.
            return "inactive"
        return "active"


matcher_cache = MatcherCache()
