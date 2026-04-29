"""Tests for P9: identification matcher + embedding Fernet round-trip.

Uses synthetic 512-D unit vectors — InsightFace is never loaded. The
matcher cache is the real ``matcher_cache`` singleton; tests call
``invalidate_all()`` between cases to keep state clean.
"""

from __future__ import annotations

from typing import Iterator

import numpy as np
import pytest
from sqlalchemy import delete, insert, select

from maugood.config import get_settings
from maugood.db import employee_photos, employees
from maugood.identification.embeddings import (
    EMBEDDING_DIM,
    decrypt_embedding,
    encrypt_embedding,
)
from maugood.identification.matcher import matcher_cache
from maugood.tenants.scope import TenantScope

TENANT = TenantScope(tenant_id=1)


def _unit_vec(seed: int, *, dim: int = EMBEDDING_DIM) -> np.ndarray:
    """Deterministic synthetic unit vector."""

    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    v /= np.linalg.norm(v)
    return v


def _rotated(v: np.ndarray, angle_rad: float) -> np.ndarray:
    """Rotate a vector slightly in its first 2D plane — keeps it near-identical."""

    out = v.copy()
    c, s = np.cos(angle_rad), np.sin(angle_rad)
    out[0], out[1] = c * v[0] - s * v[1], s * v[0] + c * v[1]
    return out / np.linalg.norm(out)


@pytest.fixture
def enrolled_employees(admin_engine):  # type: ignore[no-untyped-def]
    """Seed two employees and insert one encrypted embedding per employee.

    Each test gets a fresh pair; teardown wipes them + invalidates cache.
    """

    emp_a_vec = _unit_vec(seed=1)
    emp_b_vec = _unit_vec(seed=2)

    with admin_engine.begin() as conn:
        # Clean slate for the tables we own. We MUST NOT touch user_roles
        # here — the pilot admin's Admin role lives in that table too,
        # and wiping it locks us out of the live /api/identification/*
        # endpoints until seed_admin is re-run.
        conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
        conn.execute(delete(employees).where(employees.c.tenant_id == 1))
        # ENG department is seeded at id=1 by 0002_employees.
        dept_id = 1

        emp_a = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="EMP-A",
                full_name="Employee A",
                email=None,
                department_id=dept_id,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()
        emp_b = conn.execute(
            insert(employees)
            .values(
                tenant_id=1,
                employee_code="EMP-B",
                full_name="Employee B",
                email=None,
                department_id=dept_id,
                status="active",
            )
            .returning(employees.c.id)
        ).scalar_one()

        # One reference photo each with a pre-computed embedding.
        for emp_id, vec in [(emp_a, emp_a_vec), (emp_b, emp_b_vec)]:
            conn.execute(
                insert(employee_photos).values(
                    tenant_id=1,
                    employee_id=emp_id,
                    angle="front",
                    file_path=f"/dev/null-{emp_id}.jpg",
                    approved_by_user_id=None,
                    approved_at=None,
                    embedding=encrypt_embedding(vec),
                )
            )

    matcher_cache.invalidate_all()
    try:
        yield {
            "emp_a": {"id": int(emp_a), "vec": emp_a_vec},
            "emp_b": {"id": int(emp_b), "vec": emp_b_vec},
        }
    finally:
        matcher_cache.invalidate_all()
        with admin_engine.begin() as conn:
            conn.execute(delete(employee_photos).where(employee_photos.c.tenant_id == 1))
            conn.execute(delete(employees).where(employees.c.tenant_id == 1))


# ---------------------------------------------------------------------------
# Fernet round-trip
# ---------------------------------------------------------------------------


def test_embedding_fernet_round_trip() -> None:
    vec = _unit_vec(seed=42)
    token = encrypt_embedding(vec)
    # Ciphertext is a Fernet token (urlsafe base64, starts with 'gAAAA').
    assert token.startswith(b"gAAAA")
    assert bytes(token) != vec.tobytes()

    back = decrypt_embedding(bytes(token))
    np.testing.assert_allclose(back, vec, atol=1e-6)


def test_embedding_rejects_wrong_dimension() -> None:
    with pytest.raises(ValueError):
        encrypt_embedding(np.zeros(128, dtype=np.float32))


# ---------------------------------------------------------------------------
# Matcher: synthetic embeddings → happy / below-threshold / ambiguous
# ---------------------------------------------------------------------------


def test_matcher_exact_vector_matches_its_employee(enrolled_employees) -> None:
    m = matcher_cache.match(TENANT, enrolled_employees["emp_a"]["vec"])
    assert m is not None
    assert m.employee_id == enrolled_employees["emp_a"]["id"]
    # Exact match → cosine similarity ≈ 1.
    assert m.score > 0.99


def test_matcher_near_vector_still_matches(enrolled_employees) -> None:
    probe = _rotated(enrolled_employees["emp_b"]["vec"], angle_rad=0.05)
    m = matcher_cache.match(TENANT, probe)
    assert m is not None
    assert m.employee_id == enrolled_employees["emp_b"]["id"]


def test_matcher_below_threshold_returns_none(enrolled_employees) -> None:
    # An orthogonal probe has cosine similarity near 0 with both
    # enrolled vectors — well below the 0.45 default threshold.
    probe = _unit_vec(seed=9999)
    m = matcher_cache.match(TENANT, probe)
    assert m is None


def test_matcher_custom_threshold_is_hard_cutoff(enrolled_employees) -> None:
    probe = enrolled_employees["emp_a"]["vec"]
    # Threshold higher than the perfect-match score (which is ~1.0) is
    # physically impossible to clear — we must get None.
    m = matcher_cache.match(TENANT, probe, threshold=1.5)
    assert m is None


# ---------------------------------------------------------------------------
# Multi-angle mean-of-top-k (k=1 for pilot)
# ---------------------------------------------------------------------------


def test_matcher_uses_best_angle_per_employee(admin_engine, enrolled_employees) -> None:
    """Add a second angle for employee A that's unrelated to her front.

    Because k=1 (mean of top-1), an orthogonal "left angle" vector
    doesn't drag the score down — the matcher still picks her front
    vector for a query that matches her front.
    """

    orthogonal = _unit_vec(seed=8888)  # near-zero similarity to either seed
    with admin_engine.begin() as conn:
        conn.execute(
            insert(employee_photos).values(
                tenant_id=1,
                employee_id=enrolled_employees["emp_a"]["id"],
                angle="left",
                file_path="/dev/null-a-left.jpg",
                approved_by_user_id=None,
                approved_at=None,
                embedding=encrypt_embedding(orthogonal),
            )
        )
    matcher_cache.invalidate_employee(enrolled_employees["emp_a"]["id"])

    m = matcher_cache.match(TENANT, enrolled_employees["emp_a"]["vec"])
    assert m is not None
    assert m.employee_id == enrolled_employees["emp_a"]["id"]
    assert m.score > 0.99  # unaffected by the orthogonal angle


# ---------------------------------------------------------------------------
# Cache invalidation: per-employee reload doesn't nuke other tenants
# ---------------------------------------------------------------------------


def test_invalidate_employee_reloads_single_employee_only(
    admin_engine, enrolled_employees
) -> None:
    # Warm the cache with an initial match.
    assert matcher_cache.match(TENANT, enrolled_employees["emp_a"]["vec"]) is not None

    # Rotate employee A's embedding to a completely different vector.
    new_vec = _unit_vec(seed=4242)
    with admin_engine.begin() as conn:
        conn.execute(
            employee_photos.update()
            .where(
                employee_photos.c.tenant_id == 1,
                employee_photos.c.employee_id == enrolled_employees["emp_a"]["id"],
            )
            .values(embedding=encrypt_embedding(new_vec))
        )

    # Before invalidation the stale vector is still cached.
    m_stale = matcher_cache.match(TENANT, enrolled_employees["emp_a"]["vec"])
    assert m_stale is not None and m_stale.employee_id == enrolled_employees["emp_a"]["id"]

    matcher_cache.invalidate_employee(enrolled_employees["emp_a"]["id"])

    # After invalidation the new vector is loaded — the old query is now
    # below threshold (orthogonal-ish to new_vec).
    m_after = matcher_cache.match(TENANT, enrolled_employees["emp_a"]["vec"])
    assert m_after is None

    # But employee B's cache entry was untouched — her vector still matches.
    m_b = matcher_cache.match(TENANT, enrolled_employees["emp_b"]["vec"])
    assert m_b is not None
    assert m_b.employee_id == enrolled_employees["emp_b"]["id"]


# ---------------------------------------------------------------------------
# Threshold setting is read from the live Settings
# ---------------------------------------------------------------------------


def test_threshold_default_is_0_45() -> None:
    assert abs(get_settings().match_threshold - 0.45) < 1e-9
