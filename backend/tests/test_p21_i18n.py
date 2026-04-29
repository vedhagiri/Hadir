"""P21 — i18n module + PATCH /api/auth/preferred-language.

Covers the four pieces that have to keep working for Arabic users:
the Accept-Language parser, the dotted-key translator (with format
arguments + missing-key fallback), the resolver chain (user pref >
Accept-Language > default), and the PATCH endpoint that persists the
user's choice.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from maugood.db import get_engine, users
from maugood.i18n import (
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    parse_accept_language,
    resolve_language,
    t,
)


# --- parse_accept_language --------------------------------------------------


def test_parse_accept_language_picks_highest_q():
    # ``ar`` outranks ``en`` here even though ``en`` comes first.
    header = "en;q=0.5,ar;q=0.9,fr;q=1.0"
    assert parse_accept_language(header) == "ar"


def test_parse_accept_language_folds_regional_subtags():
    assert parse_accept_language("en-US") == "en"
    assert parse_accept_language("ar-OM,en;q=0.5") == "ar"


def test_parse_accept_language_returns_none_when_unsupported():
    assert parse_accept_language("fr,de;q=0.8") is None
    assert parse_accept_language(None) is None
    assert parse_accept_language("") is None


def test_parse_accept_language_handles_malformed_q():
    # Malformed q-values must not blow up — we just default to 1.0.
    assert parse_accept_language("ar;q=garbage") == "ar"


# --- t() ------------------------------------------------------------


def test_t_returns_arabic_for_known_key():
    en = t("notifications.approval_assigned.subject", "en")
    ar = t("notifications.approval_assigned.subject", "ar")
    assert en
    assert ar
    assert en != ar  # actually translated


def test_t_unknown_key_returns_key_itself():
    # Visible-on-purpose: a typo in a producer should surface in the
    # output rather than silently fall back to English.
    assert t("does.not.exist", "en") == "does.not.exist"
    assert t("does.not.exist", "ar") == "does.not.exist"


def test_t_format_kwargs_applied():
    # ``submitter_name`` / ``request_type`` / ``stage`` are the
    # placeholders the producer for ``approval_assigned`` actually
    # passes in. See backend/maugood/notifications/producer.py.
    out = t(
        "notifications.approval_assigned.subject",
        "en",
        submitter_name="Alice",
        request_type="leave",
        stage="Manager",
    )
    assert "Alice" in out
    assert "leave" in out


def test_t_unknown_lang_falls_back_to_default():
    # A bogus lang like "fr" doesn't crash — we get the default-lang text.
    fallback = t("notifications.approval_assigned.subject", "fr")
    expected = t("notifications.approval_assigned.subject", DEFAULT_LANGUAGE)
    assert fallback == expected


# --- resolve_language --------------------------------------------------


def test_resolve_language_user_pref_wins():
    # Accept-Language says English but the stored user prefers Arabic.
    chosen = resolve_language(
        user_preference="ar", accept_language="en-US,en;q=0.9"
    )
    assert chosen == "ar"


def test_resolve_language_falls_back_to_accept_language():
    chosen = resolve_language(user_preference=None, accept_language="ar,en;q=0.5")
    assert chosen == "ar"


def test_resolve_language_falls_back_to_default():
    chosen = resolve_language(user_preference=None, accept_language=None)
    assert chosen == DEFAULT_LANGUAGE


def test_resolve_language_ignores_invalid_user_pref():
    # Defensive: a bogus stored value (shouldn't happen — DB CHECK
    # rejects it — but we don't trust the wire) drops to the next tier.
    chosen = resolve_language(user_preference="fr", accept_language="ar")
    assert chosen == "ar"


# --- PATCH /api/auth/preferred-language ---------------------------------


def test_patch_preferred_language_sets_value(admin_user, client):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200, resp.text

    resp = client.patch(
        "/api/auth/preferred-language", json={"preferred_language": "ar"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["preferred_language"] == "ar"

    # And the row really moved.
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(users.c.preferred_language).where(users.c.id == admin_user["id"])
        ).first()
    assert row is not None
    assert row[0] == "ar"


def test_patch_preferred_language_clears_with_null(admin_user, client):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200, resp.text

    # First set to Arabic …
    resp = client.patch(
        "/api/auth/preferred-language", json={"preferred_language": "ar"}
    )
    assert resp.status_code == 200, resp.text
    # … then clear.
    resp = client.patch(
        "/api/auth/preferred-language", json={"preferred_language": None}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_language"] is None

    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            select(users.c.preferred_language).where(users.c.id == admin_user["id"])
        ).first()
    assert row is not None
    assert row[0] is None


def test_patch_preferred_language_rejects_invalid_code(admin_user, client):
    creds = {"email": admin_user["email"], "password": admin_user["password"]}
    resp = client.post("/api/auth/login", json=creds)
    assert resp.status_code == 200, resp.text
    resp = client.patch(
        "/api/auth/preferred-language", json={"preferred_language": "fr"}
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.parametrize("lang", list(SUPPORTED_LANGUAGES))
def test_supported_languages_have_full_bundle(lang):
    # Spot-check the bundles we ship — every category subject + body
    # has to be present so producers never emit ``key.itself``.
    categories = (
        "approval_assigned",
        "approval_decided",
        "overtime_flagged",
        "camera_unreachable",
        "report_ready",
        "admin_override",
    )
    for cat in categories:
        subj = t(f"notifications.{cat}.subject", lang)
        body = t(f"notifications.{cat}.body", lang)
        assert subj and not subj.endswith(".subject"), (lang, cat, subj)
        assert body and not body.endswith(".body"), (lang, cat, body)
