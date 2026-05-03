"""Shared upgrade-plan engine for ``quick-update.sh`` + ``deploy-update.sh``.

The packager (``scripts/package-release.sh``) writes a
``RELEASE-MANIFEST.json`` into every zip describing what changed
between this release and the previous one. The update scripts call
this module to:

  1. Load the manifest from the zip.
  2. Read the current install's ``VERSION`` file.
  3. Build a structured "what to do" plan — which services to
     rebuild, whether migrations apply, what env vars to warn about,
     whether the operator is jumping versions and should refuse.
  4. Print that plan to the operator before any destructive action.
  5. Execute the plan — restricted to whichever service set the
     caller (quick-update vs deploy-update) cares about.

Pure stdlib. Runs on the host where the operator extracted the zip;
no docker image needed for the planning phase.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# Manifest + version IO
# ---------------------------------------------------------------------------


@dataclass
class Manifest:
    """Parsed RELEASE-MANIFEST.json from a release zip."""

    version: str
    previous_version: Optional[str]
    commit_id: str
    previous_commit_id: Optional[str]
    all_new_install: bool
    new_migrations: list[str]
    services_changed: dict[str, bool]
    compose_changed: bool
    https_compose_changed: bool
    env_keys_added: list[str]
    env_keys_removed: list[str]
    upgrade_scripts: list[str]
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> "Manifest":
        return cls(
            version=str(data.get("version", "0.0.0")),
            previous_version=data.get("previous_version") or None,
            commit_id=str(data.get("commit_id", "unknown")),
            previous_commit_id=data.get("previous_commit_id") or None,
            all_new_install=bool(data.get("all_new_install", False)),
            new_migrations=list(data.get("new_migrations", []) or []),
            services_changed=dict(data.get("services_changed", {}) or {}),
            compose_changed=bool(data.get("compose_changed", False)),
            https_compose_changed=bool(
                data.get("https_compose_changed", False)
            ),
            env_keys_added=list(data.get("env_keys_added", []) or []),
            env_keys_removed=list(data.get("env_keys_removed", []) or []),
            upgrade_scripts=list(data.get("upgrade_scripts", []) or []),
            raw=data,
        )


def load_manifest_from_zip(zip_path: Path) -> Manifest:
    """Pull RELEASE-MANIFEST.json out of the release zip without
    extracting the whole archive. Returns a Manifest dataclass.

    Raises FileNotFoundError when the zip is missing. Returns a
    legacy-fallback Manifest with ``all_new_install=True`` when the
    zip predates the manifest format (e.g. the operator is updating
    from pre-v1.1.13 → v1.1.13)."""

    if not zip_path.exists():
        raise FileNotFoundError(f"zip not found: {zip_path}")

    with zipfile.ZipFile(zip_path) as zf:
        # The packager nests everything under maugood-vX.Y.Z/.
        # Find the prefix from the first member that has one.
        manifest_member = None
        version_member = None
        for name in zf.namelist():
            if name.endswith("/RELEASE-MANIFEST.json"):
                manifest_member = name
            elif name.endswith("/VERSION"):
                version_member = name
            if manifest_member and version_member:
                break

        if manifest_member is None:
            # Pre-manifest release — synthesise a "rebuild everything"
            # plan so the update doesn't refuse to run.
            ver = "?"
            if version_member is not None:
                ver = zf.read(version_member).decode().strip()
            return Manifest.from_dict(
                {
                    "version": ver,
                    "previous_version": None,
                    "commit_id": "unknown",
                    "previous_commit_id": None,
                    "all_new_install": True,
                    "new_migrations": [],
                    "services_changed": {
                        "backend": True,
                        "frontend": True,
                        "nginx": True,
                        "postgres": False,
                    },
                    "compose_changed": True,
                    "https_compose_changed": True,
                    "env_keys_added": [],
                    "env_keys_removed": [],
                    "upgrade_scripts": [],
                }
            )

        data = json.loads(zf.read(manifest_member).decode())
        return Manifest.from_dict(data)


def current_install_version(install_dir: Path) -> str:
    """Best-effort read of the install's current version. Order:

      1. ``${install_dir}/VERSION`` — written by the packager and by
         the update script's stamp step.
      2. ``${install_dir}/.version`` — the dev source-of-truth. Some
         installs may have it; not all.
      3. ``${install_dir}/frontend/package.json`` — last-resort.
      4. "0.0.0" if nothing matches (treated as fresh install).
    """

    candidates = [
        install_dir / "VERSION",
        install_dir / ".version",
    ]
    for p in candidates:
        if p.is_file():
            txt = p.read_text().strip()
            # VERSION may carry a leading "v"; strip it.
            txt = txt.lstrip("vV")
            if re.match(r"^\d+\.\d+\.\d+$", txt):
                return txt
    pkg = install_dir / "frontend" / "package.json"
    if pkg.is_file():
        try:
            data = json.loads(pkg.read_text())
            v = str(data.get("version", "")).strip().lstrip("vV")
            if re.match(r"^\d+\.\d+\.\d+$", v):
                return v
        except Exception:
            pass
    return "0.0.0"


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------


@dataclass
class Plan:
    """Structured upgrade plan produced by ``build_plan``."""

    current_version: str
    target_version: str
    direction: str  # "upgrade" | "same" | "downgrade"
    sequential: bool  # True when manifest.previous_version == current_version
    can_skip_check: bool  # True when allowed to bypass the sequential check
    services_to_rebuild: list[str]
    services_to_restart: list[str]
    new_migrations: list[str]
    env_keys_added: list[str]
    env_keys_removed: list[str]
    upgrade_scripts: list[str]
    compose_changed: bool
    https_compose_changed: bool
    notes: list[str]
    manifest: Manifest


def build_plan(
    manifest: Manifest,
    current_version: str,
    *,
    service_set: Iterable[str] = ("backend", "frontend", "postgres", "nginx"),
    force_skip_versions: bool = False,
) -> Plan:
    """Compute what the update script should actually do.

    ``service_set`` is the universe of services the caller knows about.
    ``quick-update.sh`` passes ``("postgres", "backend", "frontend")``
    so nginx changes from the manifest are dropped on the floor.
    """

    cur_t = _vtuple(current_version)
    tgt_t = _vtuple(manifest.version)
    if tgt_t > cur_t:
        direction = "upgrade"
    elif tgt_t == cur_t:
        direction = "same"
    else:
        direction = "downgrade"

    sequential = (
        manifest.previous_version is not None
        and _vtuple(manifest.previous_version) == cur_t
    )
    # First-time install (no .version file → current=0.0.0): treat
    # as sequential so the update doesn't refuse.
    if cur_t == (0, 0, 0):
        sequential = True

    services_to_rebuild: list[str] = []
    services_to_restart: list[str] = []
    if manifest.all_new_install:
        # Every known service rebuilds + restarts.
        for s in service_set:
            services_to_rebuild.append(s)
            services_to_restart.append(s)
    else:
        for s, changed in manifest.services_changed.items():
            if not changed:
                continue
            if s not in service_set:
                continue
            services_to_rebuild.append(s)
            services_to_restart.append(s)
        # New migrations require the backend to restart even if its
        # code didn't change — entrypoint runs alembic on boot only.
        if manifest.new_migrations and "backend" in service_set:
            if "backend" not in services_to_restart:
                services_to_restart.append("backend")

    notes: list[str] = []
    if direction == "downgrade":
        notes.append(
            "Target version is OLDER than the current install — "
            "downgrade is not supported. Restore from a backup tarball "
            "instead."
        )
    if direction == "same":
        notes.append(
            "Target version equals the installed version — re-running "
            "this is a no-op unless the bundle differs from what's on "
            "disk. Pass --force to rebuild anyway."
        )
    if not sequential and not force_skip_versions and direction == "upgrade":
        notes.append(
            f"Skipping versions: install is {current_version} but the "
            f"zip's previous_version is {manifest.previous_version!r}. "
            "Apply intermediate releases first, OR pass "
            "--force-skip-versions to bypass (data-migration scripts "
            "in skipped releases will NOT run)."
        )
    if manifest.env_keys_added:
        notes.append(
            "New env vars are present in this release. The compose "
            "YAML will use built-in defaults; set them in .env to "
            "override."
        )

    return Plan(
        current_version=current_version,
        target_version=manifest.version,
        direction=direction,
        sequential=sequential,
        can_skip_check=force_skip_versions,
        services_to_rebuild=services_to_rebuild,
        services_to_restart=services_to_restart,
        new_migrations=list(manifest.new_migrations),
        env_keys_added=list(manifest.env_keys_added),
        env_keys_removed=list(manifest.env_keys_removed),
        upgrade_scripts=list(manifest.upgrade_scripts),
        compose_changed=manifest.compose_changed,
        https_compose_changed=manifest.https_compose_changed,
        notes=notes,
        manifest=manifest,
    )


def _vtuple(v: str) -> tuple[int, int, int]:
    parts = (v or "0.0.0").lstrip("vV").split(".")
    while len(parts) < 3:
        parts.append("0")
    try:
        return tuple(int(p) for p in parts[:3])  # type: ignore[return-value]
    except ValueError:
        return (0, 0, 0)


# ---------------------------------------------------------------------------
# Operator-facing render
# ---------------------------------------------------------------------------


def print_plan(plan: Plan, *, file=sys.stdout) -> None:
    """Pretty-print the plan for the operator before they confirm."""

    bar = "=" * 64
    print(bar, file=file)
    print(f" Upgrade plan: v{plan.current_version} → v{plan.target_version}", file=file)
    print(bar, file=file)
    if plan.direction != "upgrade":
        print(f"  direction          : {plan.direction.upper()}", file=file)
    print(
        f"  previous_version   : {plan.manifest.previous_version or '— (no prior release)'}",
        file=file,
    )

    print(file=file)
    print(" What will change:", file=file)
    if plan.new_migrations:
        print(
            f"  • {len(plan.new_migrations)} schema migration(s) "
            f"(applied automatically on backend boot):",
            file=file,
        )
        for m in plan.new_migrations:
            print(f"      - {m}", file=file)
    else:
        print("  • Schema migrations  : none", file=file)

    if plan.services_to_rebuild:
        print(
            f"  • Rebuild + restart  : {', '.join(plan.services_to_rebuild)}",
            file=file,
        )
    else:
        print("  • Rebuild + restart  : none (no service code changed)", file=file)

    only_restart = sorted(
        set(plan.services_to_restart) - set(plan.services_to_rebuild)
    )
    if only_restart:
        print(
            f"  • Restart only       : {', '.join(only_restart)}  "
            "(no rebuild — config or migrations only)",
            file=file,
        )

    if plan.compose_changed or plan.https_compose_changed:
        which = []
        if plan.compose_changed:
            which.append("docker-compose.yml")
        if plan.https_compose_changed:
            which.append("docker-compose-https-local.yaml")
        print(f"  • Compose YAML       : changed ({', '.join(which)})", file=file)

    if plan.env_keys_added:
        print(file=file)
        print(" New env vars in this release:", file=file)
        for k in plan.env_keys_added:
            print(f"  + {k}", file=file)
        print(
            "  (Compose YAML provides built-in defaults; add to .env to override.)",
            file=file,
        )
    if plan.env_keys_removed:
        print(file=file)
        print(" Env vars removed in this release (safe to delete from .env):", file=file)
        for k in plan.env_keys_removed:
            print(f"  - {k}", file=file)

    if plan.upgrade_scripts:
        print(file=file)
        print(" Manual upgrade scripts shipped in this release:", file=file)
        for s in plan.upgrade_scripts:
            print(f"  • {s}", file=file)
        print(
            "  Run them after the rebuild via:",
            file=file,
        )
        print(
            "    docker compose exec backend python -m scripts.<script_name>",
            file=file,
        )

    if plan.notes:
        print(file=file)
        print(" Notes:", file=file)
        for n in plan.notes:
            for i, line in enumerate(n.splitlines()):
                print(("    " if i else "  • ") + line, file=file)

    print(bar, file=file)


# ---------------------------------------------------------------------------
# Decision helpers — used by the shell wrappers
# ---------------------------------------------------------------------------


def should_block(plan: Plan) -> Optional[str]:
    """Return a reason string when the plan should NOT proceed.
    None means proceed-OK."""

    if plan.direction == "downgrade":
        return "downgrade not supported"
    if plan.direction == "upgrade" and not plan.sequential and not plan.can_skip_check:
        return "skipping versions (pass --force-skip-versions to override)"
    return None


# ---------------------------------------------------------------------------
# CLI entrypoint — useful for "what would this update do?" smoke tests.
# ---------------------------------------------------------------------------


def _main(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(
        description="Inspect a release zip's upgrade plan against an install.",
    )
    p.add_argument("--zip", required=True, help="Release zip path.")
    p.add_argument(
        "--install-dir",
        default=".",
        help="Install directory (default: current dir).",
    )
    p.add_argument(
        "--service-set",
        default="postgres,backend,frontend,nginx",
        help="Comma-separated services the caller cares about.",
    )
    p.add_argument(
        "--force-skip-versions",
        action="store_true",
        help="Bypass the sequential-version check.",
    )
    args = p.parse_args(argv)

    manifest = load_manifest_from_zip(Path(args.zip))
    cur_v = current_install_version(Path(args.install_dir))
    plan = build_plan(
        manifest,
        cur_v,
        service_set=tuple(s.strip() for s in args.service_set.split(",") if s.strip()),
        force_skip_versions=args.force_skip_versions,
    )
    print_plan(plan)
    block = should_block(plan)
    if block:
        print(f"\nWOULD REFUSE: {block}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(_main(sys.argv[1:]))
