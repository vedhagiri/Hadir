"""Per-tenant branding (v1.0 P4).

Curated slots only — no free-form hex, no custom CSS upload, no custom
font upload. Three storables per tenant:

* ``primary_color_key`` — one of ``BRAND_PALETTE`` (8 OKLCH triples).
* ``font_key`` — one of ``FONT_OPTIONS`` (3 curated families).
* ``logo_path`` — optional PNG/SVG ≤200KB at
  ``/data/branding/{tenant_id}/logo.{ext}`` (Fernet-encrypted-at-rest
  is *not* required here — the logo is intentionally public-by-design
  inside the tenant; what we encrypt is the per-employee face data).

Module map:

* ``constants`` — BRAND_PALETTE, FONT_OPTIONS, default keys.
* ``schemas`` — Pydantic request/response models.
* ``repository`` — get-or-default + upsert against
  ``<tenant_schema>.tenant_branding``.
* ``logo`` — magic-byte validation, write/read on the data volume.
* ``css`` — derive the override CSS for one tenant; in-process cache
  keyed on ``(tenant_id, primary_color_key, font_key)``.
* ``router`` — ``/api/branding/*`` (tenant Admin) +
  ``/api/super-admin/tenants/{id}/branding/*`` (operators).

Red lines (BRD FR-BRD-002):

* No free-form hex on ``primary_color_key``. Refuse with 400 if the
  key isn't in BRAND_PALETTE.
* No font upload. The three keys map to Google-hosted families
  preloaded in ``frontend/index.html``; that's the entire allowed
  surface.
* No custom CSS injection. The CSS we serve is generated from the two
  curated keys and a fixed template.

If a future prompt asks to extend any of these, the answer is **no**
without a BRD revision.
"""

from hadir.branding.router import router

__all__ = ["router"]
