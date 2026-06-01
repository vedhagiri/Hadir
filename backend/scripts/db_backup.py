#!/usr/bin/env python3
"""Interactive table-level PostgreSQL backup / restore for Maugood.

Runs on the HOST and drives ``pg_dump`` / ``pg_restore`` / ``psql``
inside the running Postgres container via ``docker exec`` — the host
ships no PostgreSQL client binaries, the container ships v15.

This is the granular companion to ``backend/scripts/backup.sh`` (P24,
full per-schema snapshots). Where ``backup.sh`` dumps every schema for
disaster recovery, this tool lets an operator hand-pick individual
tables within ONE schema, see estimated row counts before dumping, and
restore a chosen backup file.

Multi-tenant note: the same 43 table names live in ``main``,
``tenant_<slug>`` ... schemas. A flat table list would be ambiguous, so
the flow always selects a SCHEMA first, then tables inside it.

Usage
-----
    python3 backend/scripts/db_backup.py list
    python3 backend/scripts/db_backup.py backup
    python3 backend/scripts/db_backup.py backup --schema tenant_inaisys --tables cameras,employees
    python3 backend/scripts/db_backup.py backup --schema tenant_inaisys --tables all
    python3 backend/scripts/db_backup.py restore
    python3 backend/scripts/db_backup.py restore --file <path> [--mode replace|full|append] [--yes]

Config (env vars, sane defaults)
--------------------------------
    MAUGOOD_PG_CONTAINER      Postgres container name   (auto-detect, fallback hadir-postgres-1)
    MAUGOOD_PG_DB             database name             (maugood)
    MAUGOOD_PG_USER           superuser / owner role    (maugood)
    MAUGOOD_TABLE_BACKUP_DIR  output directory          (<repo>/db_backups)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_DEFAULT_CONTAINER = "hadir-postgres-1"
MANIFEST_VERSION = 1


def _env(name: str, default: str) -> str:
    val = os.environ.get(name)
    return val if val else default


def pg_db() -> str:
    return _env("MAUGOOD_PG_DB", "maugood")


def pg_user() -> str:
    return _env("MAUGOOD_PG_USER", "maugood")


def backup_dir() -> Path:
    raw = os.environ.get("MAUGOOD_TABLE_BACKUP_DIR")
    return Path(raw) if raw else (_REPO_ROOT / "db_backups")


def detect_container() -> str:
    """Pick the Postgres container: env override, default name, or auto-detect."""
    override = os.environ.get("MAUGOOD_PG_CONTAINER")
    if override:
        return override
    names = _docker_running_names()
    if _DEFAULT_CONTAINER in names:
        return _DEFAULT_CONTAINER
    # Auto-detect: first running container whose name contains "postgres"
    for n in names:
        if "postgres" in n.lower():
            return n
    return _DEFAULT_CONTAINER


def _docker_running_names() -> list[str]:
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def info(msg: str) -> None:
    print(msg)


def warn(msg: str) -> None:
    print(f"\033[33m{msg}\033[0m", file=sys.stderr)


def die(msg: str, code: int = 2) -> None:
    print(f"\033[31mERROR: {msg}\033[0m", file=sys.stderr)
    sys.exit(code)


def fmt_rows(n: int) -> str:
    # reltuples is -1 for a table that has never been ANALYZEd ("unknown").
    return "unknown" if n < 0 else f"{n:,}"


def human_bytes(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{f:.1f} {unit}" if unit != "B" else f"{int(f)} B"
        f /= 1024
    return f"{n} B"


# ---------------------------------------------------------------------------
# docker / psql plumbing
# ---------------------------------------------------------------------------

class Ctx:
    """Resolved connection context for one invocation."""

    def __init__(self) -> None:
        self.container = detect_container()
        self.db = pg_db()
        self.user = pg_user()

    def base(self, interactive_stdin: bool = False) -> list[str]:
        cmd = ["docker", "exec"]
        if interactive_stdin:
            cmd.append("-i")
        cmd.append(self.container)
        return cmd

    def assert_reachable(self) -> None:
        if "docker" not in _which_docker():
            die("`docker` not found on PATH — this tool drives pg_dump via docker exec.")
        names = _docker_running_names()
        if self.container not in names:
            die(
                f"Postgres container '{self.container}' is not running.\n"
                f"  Running containers: {', '.join(names) or '(none)'}\n"
                f"  Override with MAUGOOD_PG_CONTAINER=<name>."
            )


def _which_docker() -> str:
    from shutil import which
    return which("docker") or ""


def run_query(ctx: Ctx, sql: str) -> list[list[str]]:
    """Run a SELECT and return CSV-parsed rows (no header)."""
    cmd = ctx.base() + [
        "psql", "-U", ctx.user, "-d", ctx.db,
        "--no-align", "--quiet", "--tuples-only",
        "--csv", "-c", sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"query failed:\n{proc.stderr.strip()}")
    rows = list(csv.reader(io.StringIO(proc.stdout)))
    return [r for r in rows if r]


def server_version(ctx: Ctx) -> str:
    rows = run_query(ctx, "SHOW server_version;")
    return rows[0][0] if rows else "unknown"


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

def list_schemas(ctx: Ctx) -> list[tuple[str, int, int]]:
    """(schema, table_count, est_total_rows), user schemas only."""
    sql = (
        "SELECT n.nspname, count(c.oid)::bigint, "
        "       coalesce(sum(GREATEST(c.reltuples, 0)), 0)::bigint "
        "FROM pg_namespace n "
        "LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' "
        "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
        "  AND n.nspname NOT LIKE 'pg_%' "
        "GROUP BY n.nspname ORDER BY n.nspname;"
    )
    out: list[tuple[str, int, int]] = []
    for row in run_query(ctx, sql):
        out.append((row[0], int(row[1]), int(row[2])))
    return out


def list_tables(ctx: Ctx, schema: str) -> list[tuple[str, int]]:
    """(table, est_rows) for one schema, alphabetical."""
    if not _IDENT_RE.match(schema):
        die(f"refusing unsafe schema name: {schema!r}")
    sql = (
        "SELECT c.relname, c.reltuples::bigint "
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        f"WHERE c.relkind = 'r' AND n.nspname = '{schema}' "
        "ORDER BY c.relname;"
    )
    rows = [(r[0], int(r[1])) for r in run_query(ctx, sql)]
    # reltuples is -1 for never-ANALYZEd tables. Those are reliably the
    # small/empty ones (heavy tables already carry an estimate), so an
    # exact count is cheap — batch them into a single round-trip.
    unknown = [t for t, n in rows if n < 0]
    if unknown:
        counts = _batch_counts(ctx, schema, unknown)
        rows = [(t, counts.get(t, n) if n < 0 else n) for t, n in rows]
    return rows


def _batch_counts(ctx: Ctx, schema: str, tables: list[str]) -> dict[str, int]:
    if not _IDENT_RE.match(schema):
        die(f"refusing unsafe schema name: {schema!r}")
    parts = []
    for i, t in enumerate(tables):
        if not _IDENT_RE.match(t):
            die(f"refusing unsafe table name: {t!r}")
        parts.append(f'SELECT {i} AS k, count(*) AS c FROM "{schema}"."{t}"')
    sql = " UNION ALL ".join(parts) + " ORDER BY k;"
    return {tables[int(r[0])]: int(r[1]) for r in run_query(ctx, sql)}


def exact_count(ctx: Ctx, schema: str, table: str) -> int:
    if not (_IDENT_RE.match(schema) and _IDENT_RE.match(table)):
        die(f"refusing unsafe identifier: {schema}.{table}")
    rows = run_query(ctx, f'SELECT count(*) FROM "{schema}"."{table}";')
    return int(rows[0][0]) if rows else 0


def schema_exists(ctx: Ctx, schema: str) -> bool:
    if not _IDENT_RE.match(schema):
        die(f"refusing unsafe schema name: {schema!r}")
    return bool(run_query(ctx, f"SELECT 1 FROM pg_namespace WHERE nspname = '{schema}';"))


# ---------------------------------------------------------------------------
# Selection parsing
# ---------------------------------------------------------------------------

def parse_selection(raw: str, n: int) -> list[int]:
    """Parse '1,3,5' / '1-4' / 'all' into 0-based indices."""
    raw = raw.strip().lower()
    if raw in ("all", "*"):
        return list(range(n))
    picked: set[int] = set()
    for part in raw.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            if not (a.isdigit() and b.isdigit()):
                die(f"bad range: {part!r}")
            lo, hi = int(a), int(b)
            if lo < 1 or hi > n or lo > hi:
                die(f"range out of bounds (1-{n}): {part!r}")
            picked.update(range(lo - 1, hi))
        else:
            if not part.isdigit():
                die(f"not a number: {part!r}")
            idx = int(part)
            if idx < 1 or idx > n:
                die(f"out of bounds (1-{n}): {idx}")
            picked.add(idx - 1)
    if not picked:
        die("no tables selected.")
    return sorted(picked)


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

def choose_schema_interactive(ctx: Ctx) -> str:
    schemas = list_schemas(ctx)
    if not schemas:
        die("no user schemas found.")
    info("\nAvailable schemas:\n")
    for i, (name, tcount, rows) in enumerate(schemas, 1):
        info(f"  {i:>2}. {name:<18} {tcount:>3} tables   ~{rows:,} rows est.")
    info("")
    while True:
        raw = input(f"Select a schema [1-{len(schemas)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(schemas):
            return schemas[int(raw) - 1][0]
        warn("  enter a single number from the list.")


def choose_tables_interactive(ctx: Ctx, schema: str) -> list[str]:
    tables = list_tables(ctx, schema)
    if not tables:
        die(f"schema '{schema}' has no tables.")
    info(f"\nTables in '{schema}':\n")
    for i, (name, rows) in enumerate(tables, 1):
        info(f"  {i:>2}. {name:<32} ~{fmt_rows(rows)} rows")
    info("")
    info("Select tables to backup (e.g. 1,3,5  or  1-4  or  all):")
    raw = input("> ").strip()
    idxs = parse_selection(raw, len(tables))
    return [tables[i][0] for i in idxs]


def do_backup(ctx: Ctx, schema: str, tables: list[str], assume_yes: bool) -> None:
    # Validate the chosen tables, then take EXACT counts (the selection is
    # small, and an accurate pre-dump number is worth a quick scan).
    all_tables = {t for t, _ in list_tables(ctx, schema)}
    for t in tables:
        if t not in all_tables:
            die(f"table '{schema}.{t}' does not exist.")
        if not _IDENT_RE.match(t):
            die(f"refusing unsafe table name: {t!r}")

    selected = [(t, exact_count(ctx, schema, t)) for t in tables]
    total_rows = sum(r for _, r in selected)

    info("\nBackup will include:\n")
    for t, r in selected:
        info(f"  ✓ {t:<32} {r:,} rows")
    info(f"\n  schema : {schema}")
    info(f"  tables : {len(selected)}")
    info(f"  rows   : {total_rows:,}")

    if not assume_yes:
        if input("\nProceed? [y/N]: ").strip().lower() not in ("y", "yes"):
            info("aborted.")
            return

    out_dir = backup_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if len(selected) == 1:
        label = selected[0][0]
    else:
        label = f"{len(selected)}tables"
    stem = f"maugood_{schema}_{label}_{ts}"
    dump_path = out_dir / f"{stem}.dump"
    manifest_path = out_dir / f"{stem}.json"

    # Build pg_dump: custom format, table-scoped, no ownership noise.
    dump_args = [
        "pg_dump", "-U", ctx.user, "-d", ctx.db,
        "--format=custom", "--no-owner", "--no-privileges", "--verbose",
    ]
    for t in tables:
        dump_args += ["-t", f"{schema}.{t}"]

    info(f"\nDumping {len(selected)} table(s) from '{schema}' ...")
    cmd = ctx.base() + dump_args
    with open(dump_path, "wb") as fh:
        proc = subprocess.run(cmd, stdout=fh, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        # Clean up the half-written file so it can't be mistaken for valid.
        dump_path.unlink(missing_ok=True)
        die(f"pg_dump failed:\n{proc.stderr.decode(errors='replace').strip()}")

    size = dump_path.stat().st_size
    manifest = {
        "tool": "maugood-db-backup",
        "manifest_version": MANIFEST_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "pg_server_version": server_version(ctx),
        "container": ctx.container,
        "database": ctx.db,
        "schema": schema,
        "tables": [{"name": t, "rows": r} for t, r in selected],
        "dump_file": dump_path.name,
        "dump_format": "custom",
        "dump_bytes": size,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))

    info("\n✓ Backup complete")
    info(f"    file     : {dump_path}")
    info(f"    manifest : {manifest_path}")
    info(f"    size     : {human_bytes(size)}")
    info(f"    tables   : {', '.join(tables)}")


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

def find_backups(out_dir: Path) -> list[Path]:
    if not out_dir.is_dir():
        return []
    files = sorted(out_dir.glob("*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files


def load_manifest(dump_path: Path) -> dict | None:
    mp = dump_path.with_suffix(".json")
    if mp.is_file():
        try:
            return json.loads(mp.read_text())
        except (OSError, json.JSONDecodeError):
            return None
    return None


def archive_tables(ctx: Ctx, dump_path: Path, manifest: dict | None) -> tuple[str | None, list[str]]:
    """Return (schema, [tables]) — from manifest, else from `pg_restore -l`."""
    if manifest:
        return manifest.get("schema"), [t["name"] for t in manifest.get("tables", [])]
    # Fallback: introspect the archive TOC.
    cmd = ctx.base(interactive_stdin=True) + ["pg_restore", "-l"]
    with open(dump_path, "rb") as fh:
        proc = subprocess.run(cmd, stdin=fh, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"could not read archive table of contents:\n{proc.stderr.strip()}")
    schema = None
    tables: list[str] = []
    for line in proc.stdout.splitlines():
        # e.g. "123; 1259 TABLE tenant_inaisys cameras maugood"
        m = re.search(r"\bTABLE DATA\s+(\S+)\s+(\S+)\s+\S+\s*$", line)
        if m:
            schema = m.group(1)
            tables.append(m.group(2))
    return schema, sorted(set(tables))


def choose_backup_interactive(ctx: Ctx, out_dir: Path) -> Path:
    files = find_backups(out_dir)
    if not files:
        die(f"no .dump files found in {out_dir}")
    info(f"\nBackups in {out_dir}:\n")
    for i, f in enumerate(files, 1):
        man = load_manifest(f)
        when = "?"
        summary = ""
        if man:
            when = man.get("created_at", "?")[:19].replace("T", " ")
            schema = man.get("schema", "?")
            tbls = [t["name"] for t in man.get("tables", [])]
            summary = f"{schema} → {', '.join(tbls[:4])}" + ("…" if len(tbls) > 4 else "")
        size = human_bytes(f.stat().st_size)
        info(f"  {i:>2}. {f.name}")
        info(f"      {when}   {size}   {summary}")
    info("")
    while True:
        raw = input(f"Select a backup to restore [1-{len(files)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(files):
            return files[int(raw) - 1]
        warn("  enter a single number from the list.")


def do_restore(ctx: Ctx, dump_path: Path, mode: str, assume_yes: bool,
               target_schema: str | None = None) -> None:
    if not dump_path.is_file():
        die(f"backup file not found: {dump_path}")
    manifest = load_manifest(dump_path)
    schema, tables = archive_tables(ctx, dump_path, manifest)

    cross = bool(target_schema) and target_schema != schema

    # --- cross-schema validation (before any prompt) ---------------------
    if cross:
        if not _IDENT_RE.match(target_schema or ""):
            die(f"invalid --target-schema: {target_schema!r}")
        if mode == "full":
            die("--mode full is not supported with --target-schema "
                "(cross-schema restore is data-only). Use replace or append.")
        if not schema:
            die("cannot rewrite into a different schema: the archive's source "
                "schema is unknown. Re-run the backup so a manifest is written.")
        if not schema_exists(ctx, target_schema or ""):
            die(f"target schema '{target_schema}' does not exist.")
        target_tables = {t for t, _ in list_tables(ctx, target_schema or "")}
        missing = [t for t in tables if t not in target_tables]
        if missing:
            die(f"target schema '{target_schema}' is missing table(s): "
                f"{', '.join(missing)} — schema structures differ, refusing.")

    info(f"\nRestore plan for {dump_path.name}:")
    if cross:
        info(f"  source : {schema}")
        info(f"  target : {target_schema}   (cross-schema copy)")
    else:
        info(f"  schema : {schema}")
    info(f"  tables : {', '.join(tables) if tables else '(unknown)'}")
    info(f"  mode   : {mode}")
    dest = target_schema if cross else schema
    if mode == "replace":
        info(f"    → delete existing rows in {dest}.{{…}}, then load backup data")
    elif mode == "full":
        info("    → DROP + recreate the tables, then load (may fail if other tables FK-reference them)")
    elif mode == "append":
        info(f"    → load backup data into {dest} on top of existing rows (no delete)")

    warn("\n  This modifies the LIVE database. There is no undo.")
    if cross:
        warn(f"  CROSS-TENANT: this writes {schema}'s data into {target_schema}, "
             f"overwriting {target_schema}'s rows in those tables.")
    if not assume_yes:
        typed = input("  Type RESTORE to proceed: ").strip()
        if typed != "RESTORE":
            info("aborted.")
            return

    if cross:
        _restore_cross_schema(ctx, dump_path, schema or "", tables,
                              target_schema or "", mode)
    elif mode == "full":
        _restore_full(ctx, dump_path)
    else:
        if mode == "replace":
            if not (schema and tables):
                die("cannot run 'replace' without knowing the archive's schema/tables; "
                    "use --mode append or --mode full.")
            _delete_rows(ctx, schema, tables)
        _restore_data_only(ctx, dump_path)

    info("\n✓ Restore complete")
    if tables:
        info(f"    restored {len(tables)} table(s) into '{dest}'")


def _delete_rows(ctx: Ctx, schema: str, tables: list[str]) -> None:
    if not _IDENT_RE.match(schema):
        die(f"refusing unsafe schema name: {schema!r}")
    stmts = ["SET session_replication_role = replica;"]
    for t in tables:
        if not _IDENT_RE.match(t):
            die(f"refusing unsafe table name: {t!r}")
        stmts.append(f'DELETE FROM "{schema}"."{t}";')
    stmts.append("SET session_replication_role = default;")
    sql = " ".join(stmts)
    info(f"  clearing {len(tables)} table(s) ...")
    cmd = ctx.base() + [
        "psql", "-U", ctx.user, "-d", ctx.db,
        "-v", "ON_ERROR_STOP=1", "--single-transaction", "-c", sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"clearing rows failed:\n{proc.stderr.strip()}")


def _restore_data_only(ctx: Ctx, dump_path: Path) -> None:
    info("  loading data ...")
    cmd = ctx.base(interactive_stdin=True) + [
        "pg_restore", "-U", ctx.user, "-d", ctx.db,
        "--data-only", "--disable-triggers", "--no-owner", "--verbose",
    ]
    with open(dump_path, "rb") as fh:
        proc = subprocess.run(cmd, stdin=fh, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        die(f"pg_restore failed:\n{proc.stderr.decode(errors='replace').strip()}")


def _restore_full(ctx: Ctx, dump_path: Path) -> None:
    info("  dropping + recreating + loading ...")
    cmd = ctx.base(interactive_stdin=True) + [
        "pg_restore", "-U", ctx.user, "-d", ctx.db,
        "--clean", "--if-exists", "--no-owner", "--verbose",
    ]
    with open(dump_path, "rb") as fh:
        proc = subprocess.run(cmd, stdin=fh, stderr=subprocess.PIPE)
    # pg_restore may exit non-zero on benign "does not exist" DROPs; surface
    # stderr but treat only real load failures as fatal.
    stderr = proc.stderr.decode(errors="replace")
    if proc.returncode != 0:
        hard = [ln for ln in stderr.splitlines()
                if "error" in ln.lower() and "does not exist" not in ln.lower()]
        if hard:
            die("pg_restore reported errors:\n" + "\n".join(hard))
        warn("  (ignored benign DROP-IF-EXISTS notices)")


# --- cross-schema restore --------------------------------------------------

def _rewrite_schema_sql(sql_text: str, source: str, target: str) -> str:
    """Rewrite `source.` → `target.` on SQL statement lines only.

    Data rows inside a ``COPY … FROM stdin;`` block (up to the lone ``\\.``
    terminator) are emitted verbatim — a value that happens to contain the
    source schema name must not be touched. The qualifier is matched only
    when not preceded by an identifier char, so ``domain.`` never matches a
    source schema named ``main``.
    """
    pat = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(source) + r"\.")
    out: list[str] = []
    in_copy = False
    for line in sql_text.splitlines(keepends=True):
        if in_copy:
            out.append(line)
            if line.rstrip("\n") == r"\.":
                in_copy = False
            continue
        rewritten = pat.sub(target + ".", line)
        out.append(rewritten)
        if re.match(r"^COPY\b.*\bFROM stdin;\s*$", rewritten):
            in_copy = True
    return "".join(out)


def _dump_data_only_sql(ctx: Ctx, dump_path: Path) -> str:
    cmd = ctx.base(interactive_stdin=True) + [
        "pg_restore", "--data-only", "--disable-triggers", "--no-owner", "-f", "-",
    ]
    with open(dump_path, "rb") as fh:
        proc = subprocess.run(cmd, stdin=fh, capture_output=True)
    if proc.returncode != 0:
        die(f"could not render archive to SQL:\n{proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout.decode("utf-8", errors="replace")


def _run_sql_script(ctx: Ctx, sql_text: str) -> None:
    cmd = ctx.base(interactive_stdin=True) + [
        "psql", "-U", ctx.user, "-d", ctx.db,
        "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q",
    ]
    proc = subprocess.run(cmd, input=sql_text.encode("utf-8"), capture_output=True)
    if proc.returncode != 0:
        die(f"restore failed (rolled back):\n{proc.stderr.decode(errors='replace').strip()}")


def _restore_cross_schema(ctx: Ctx, dump_path: Path, source: str,
                          tables: list[str], target: str, mode: str) -> None:
    info(f"  rendering archive and rewriting '{source}' → '{target}' ...")
    sql = _rewrite_schema_sql(_dump_data_only_sql(ctx, dump_path), source, target)

    # One transaction: disable FK triggers, clear the target (replace mode),
    # then load. session_replication_role=replica means cross-table FK order
    # doesn't matter and resets when the psql session ends.
    prologue = ["SET session_replication_role = replica;"]
    if mode == "replace":
        for t in tables:
            if not _IDENT_RE.match(t):
                die(f"refusing unsafe table name: {t!r}")
            prologue.append(f'DELETE FROM "{target}"."{t}";')
    info(f"  loading {len(tables)} table(s) into '{target}' ...")
    _run_sql_script(ctx, "\n".join(prologue) + "\n" + sql)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_list(ctx: Ctx, _args: argparse.Namespace) -> None:
    schemas = list_schemas(ctx)
    info(f"\nDatabase '{ctx.db}' on container '{ctx.container}' "
         f"(PostgreSQL {server_version(ctx)})")
    info(f"Schemas: {len(schemas)}   Tables: {sum(s[1] for s in schemas)}\n")
    for name, tcount, rows in schemas:
        info(f"• {name}  ({tcount} tables, ~{rows:,} rows est.)")
        for i, (tname, trows) in enumerate(list_tables(ctx, name), 1):
            info(f"    {i:>2}. {tname:<32} ~{fmt_rows(trows)} rows")
        info("")


def cmd_backup(ctx: Ctx, args: argparse.Namespace) -> None:
    schema = args.schema or choose_schema_interactive(ctx)
    if not _IDENT_RE.match(schema):
        die(f"invalid schema name: {schema!r}")
    valid = {t for t, _ in list_tables(ctx, schema)}
    if not valid:
        die(f"schema '{schema}' not found or has no tables.")

    if args.tables:
        raw = args.tables.strip().lower()
        if raw == "all":
            tables = sorted(valid)
        else:
            tables = [t.strip() for t in args.tables.split(",") if t.strip()]
            missing = [t for t in tables if t not in valid]
            if missing:
                die(f"unknown table(s) in '{schema}': {', '.join(missing)}")
    else:
        tables = choose_tables_interactive(ctx, schema)

    do_backup(ctx, schema, tables, assume_yes=args.yes)


def cmd_restore(ctx: Ctx, args: argparse.Namespace) -> None:
    if args.file:
        dump_path = Path(args.file)
    else:
        dump_path = choose_backup_interactive(ctx, backup_dir())
    do_restore(ctx, dump_path, mode=args.mode, assume_yes=args.yes,
               target_schema=args.target_schema)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="db_backup.py",
        description="Interactive table-level Postgres backup/restore (Maugood).",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="show schemas + tables + estimated row counts")

    b = sub.add_parser("backup", help="back up selected tables from one schema")
    b.add_argument("--schema", help="schema to back up (skips the schema prompt)")
    b.add_argument("--tables", help="comma list of tables, or 'all' (skips the table prompt)")
    b.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    r = sub.add_parser("restore", help="restore a backup file")
    r.add_argument("--file", help="path to a .dump file (skips the picker)")
    r.add_argument("--mode", choices=("replace", "full", "append"), default="replace",
                   help="replace (delete+load, default) | full (drop+recreate) | append (load only)")
    r.add_argument("--target-schema",
                   help="restore into a DIFFERENT schema (cross-schema copy, data-only); "
                        "rewrites the dump's schema qualifier. full mode not allowed.")
    r.add_argument("--yes", action="store_true", help="skip the RESTORE confirmation")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctx = Ctx()
    ctx.assert_reachable()
    if args.command == "list":
        cmd_list(ctx, args)
    elif args.command == "backup":
        cmd_backup(ctx, args)
    elif args.command == "restore":
        cmd_restore(ctx, args)
    else:  # pragma: no cover
        die(f"unknown command: {args.command}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\naborted.", file=sys.stderr)
        sys.exit(130)
