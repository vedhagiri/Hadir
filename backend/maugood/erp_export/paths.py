"""Safe output path resolution for the ERP file-drop runner.

The operator types a relative or absolute path in Settings →
Integrations → ERP Export. We treat that string as untrusted and
constrain the resolved path to live strictly under
``{MAUGOOD_ERP_EXPORT_ROOT}/{tenant_id}/`` — the load-bearing P19 red
line: "Never write files outside ``/data/erp/{tenant_id}/``."

The function refuses:

* ``..`` traversal.
* Symlinks that point outside the tenant root (best-effort — we
  resolve via ``Path.resolve(strict=False)`` which follows symlinks
  on existing path components).
* Absolute paths that don't start with the tenant root.

Empty input falls back to the root itself; the runner appends a
``maugood-attendance-{ts}.{ext}`` filename when the resolved path is a
directory.
"""

from __future__ import annotations

from pathlib import Path

from maugood.config import get_settings


class UnsafeOutputPath(ValueError):
    """Raised when the operator-supplied path escapes the tenant root."""


def tenant_root(*, tenant_id: int) -> Path:
    """Return ``{MAUGOOD_ERP_EXPORT_ROOT}/{tenant_id}`` as an absolute Path."""

    return (Path(get_settings().erp_export_root) / str(tenant_id)).resolve()


def resolve_safe_dir(*, tenant_id: int, raw: str) -> Path:
    """Resolve ``raw`` to an absolute directory under the tenant root.

    Empty / whitespace-only input returns the tenant root itself.
    Anything that escapes via ``..`` or that names an absolute path
    outside the root raises ``UnsafeOutputPath``.

    The directory is **not** created here — the caller decides when
    to ``mkdir(parents=True, exist_ok=True)``.
    """

    root = tenant_root(tenant_id=tenant_id)
    text = (raw or "").strip()
    if not text:
        return root

    candidate = Path(text)
    if candidate.is_absolute():
        # Operator typed an absolute path — accept only if it's
        # already inside the tenant root.
        resolved = candidate.resolve(strict=False)
    else:
        resolved = (root / candidate).resolve(strict=False)

    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise UnsafeOutputPath(
            "output_path must resolve under "
            f"{root} (got {resolved})"
        ) from exc
    return resolved
