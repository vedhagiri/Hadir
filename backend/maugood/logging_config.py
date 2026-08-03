"""Maugood logging setup (v1.0 P25).

Two file handlers in addition to stdout:

* ``backend/logs/app.log``  — the regular root logger,
  rotated daily at midnight, 30 backups kept, gzip-compressed
  on rotation.
* ``backend/logs/audit.log`` — a *separate* logger named
  ``maugood.audit`` carries the application-side audit
  breadcrumbs (PDPL deletes, retention sweeps, role
  switches, OIDC callbacks, etc.). Same rotation policy.

The DB-side ``audit_log`` table (P3) remains the source of
truth for cryptographic-audit-style records — these files are
the operator-facing breadcrumbs that don't have to survive
schema drops.

stdout still gets every line so ``docker logs`` keeps working.
The file handlers are mounted on a volume in production so
rotation survives container restarts.

Boot order: ``main.create_app`` calls ``configure_logging()``
once, before any handler emits. The function is idempotent —
calling it twice replaces the handlers cleanly so a test that
imports ``main`` fresh doesn't double-stack output.
"""

from __future__ import annotations

import gzip
import logging
import logging.handlers
import os
import re
import shutil
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_LOG_DIR = Path(os.environ.get("MAUGOOD_LOG_DIR", "/app/logs"))
APP_LOG_NAME = "app.log"
AUDIT_LOG_NAME = "audit.log"

# Daily rotation, 30 backups kept (matches BRD §"Logs"
# retention). Operators tighten via ``MAUGOOD_LOG_BACKUP_COUNT``
# without code changes.
DEFAULT_BACKUP_COUNT = int(os.environ.get("MAUGOOD_LOG_BACKUP_COUNT", "30"))

_LINE_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


class GzipRotatingFileHandler(logging.handlers.TimedRotatingFileHandler):
    """``TimedRotatingFileHandler`` that gzips on rotation.

    The stdlib handler renames the active file to
    ``app.log.YYYY-MM-DD`` and starts a fresh one. We hook the
    post-rotation step to compress the old file and drop the
    plain copy. ``gzip`` saves ~80% on a typical Maugood log
    file (lots of repeated INFO breadcrumbs); over a 30-day
    retention window the difference is the whole point of the
    rotation.
    """

    def __init__(
        self,
        filename: str,
        *,
        when: str = "midnight",
        interval: int = 1,
        backup_count: int = DEFAULT_BACKUP_COUNT,
        utc: bool = True,
    ) -> None:
        super().__init__(
            filename,
            when=when,
            interval=interval,
            backupCount=backup_count,
            utc=utc,
        )

    def doRollover(self) -> None:  # noqa: N802 — stdlib spelling
        super().doRollover()
        # The stdlib has just renamed the file to ``<name>.<suffix>``.
        # Find every rotated-but-not-yet-gz'd sibling and gzip it.
        log_path = Path(self.baseFilename)
        log_dir = log_path.parent
        prefix = log_path.name + "."
        for sibling in log_dir.iterdir():
            if not sibling.is_file():
                continue
            if not sibling.name.startswith(prefix):
                continue
            if sibling.name.endswith(".gz"):
                continue
            gz_path = sibling.with_suffix(sibling.suffix + ".gz")
            try:
                with sibling.open("rb") as src, gzip.open(gz_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                sibling.unlink()
            except OSError as exc:
                logger.warning(
                    "log rotation: gzip failed for %s: %s", sibling, exc
                )


# Paths whose next segment is a live credential. Uvicorn's access logger
# writes the full request line, so without this the device push token would
# sit in plaintext in app.log and in ``docker logs`` — the exact leak the
# "no secrets in logs" red line exists to prevent. Our own log statements
# never carry the token; this covers the framework's.
_SECRET_PATH_RE = re.compile(
    r"(?P<prefix>/(?:hik|api/devices/ingest)/)(?P<secret>[^/?\s\"']+)"
)


def _redact_secret_paths(text: str) -> str:
    return _SECRET_PATH_RE.sub(r"\g<prefix>***", text)


class RedactSecretPathsFilter(logging.Filter):
    """Strip credential-bearing URL segments from any log record.

    Rewrites both the message and the positional args, because uvicorn
    passes the request path as an arg and formats it later — redacting only
    the pre-format message would miss it entirely.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and "/" in record.msg:
            record.msg = _redact_secret_paths(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(
                    _redact_secret_paths(a) if isinstance(a, str) else a
                    for a in record.args
                )
            elif isinstance(record.args, dict):
                record.args = {
                    k: _redact_secret_paths(v) if isinstance(v, str) else v
                    for k, v in record.args.items()
                }
        return True


def configure_logging(
    *,
    log_dir: Path | None = None,
    backup_count: int = DEFAULT_BACKUP_COUNT,
    enable_files: bool | None = None,
) -> None:
    """Idempotently set up the root + audit loggers.

    Parameters mirror the env knobs so tests can override
    cleanly. ``enable_files=False`` keeps the stdout handler
    only — useful for ``pytest`` runs where a stray rotation
    thread on a temp dir is more trouble than it's worth.
    """

    if enable_files is None:
        # Default: enable file handlers unless explicitly
        # disabled via env. Tests opt out via the
        # ``MAUGOOD_LOG_DISABLE_FILES`` env var the conftest sets.
        enable_files = (
            os.environ.get("MAUGOOD_LOG_DISABLE_FILES", "0") not in ("1", "true", "True")
        )

    log_dir = log_dir or DEFAULT_LOG_DIR

    # Root logger: stdout + (optional) app.log file.
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    formatter = logging.Formatter(_LINE_FORMAT)
    redact = RedactSecretPathsFilter()
    stdout = logging.StreamHandler(sys.stdout)
    stdout.setFormatter(formatter)
    stdout.addFilter(redact)
    root.addHandler(stdout)

    # Uvicorn's access logger does not propagate to root by default, so the
    # filter has to be attached to it directly as well.
    for name in ("uvicorn.access", "uvicorn.error"):
        access = logging.getLogger(name)
        access.addFilter(redact)
        for h in access.handlers:
            h.addFilter(redact)

    if enable_files:
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # Volume not mounted, container started without the
            # logs dir — fall back to stdout-only and warn so
            # the operator notices.
            logger.warning(
                "log dir %s not writable (%s); files disabled", log_dir, exc
            )
            enable_files = False

    if enable_files:
        app_handler = GzipRotatingFileHandler(
            str(log_dir / APP_LOG_NAME), backup_count=backup_count
        )
        app_handler.setFormatter(formatter)
        app_handler.addFilter(redact)
        root.addHandler(app_handler)

    root.setLevel(logging.INFO)

    # Audit logger: dedicated file, no stdout duplication.
    # ``propagate=False`` keeps audit lines off the regular
    # app.log so an operator filtering one stream doesn't see
    # the other.
    audit = logging.getLogger("maugood.audit")
    for h in list(audit.handlers):
        audit.removeHandler(h)
    audit.propagate = False
    audit.setLevel(logging.INFO)

    if enable_files:
        audit_handler = GzipRotatingFileHandler(
            str(log_dir / AUDIT_LOG_NAME), backup_count=backup_count
        )
        audit_handler.setFormatter(formatter)
        audit.addHandler(audit_handler)
    else:
        # Even with files disabled, surface audit breadcrumbs
        # somewhere — pipe them through stderr so operators
        # tailing ``docker logs`` see them too.
        stderr = logging.StreamHandler(sys.stderr)
        stderr.setFormatter(formatter)
        audit.addHandler(stderr)


def audit_logger() -> logging.Logger:
    """Convenience accessor for the dedicated audit logger.

    Producers (PDPL deletes, retention sweeps, etc.) call
    ``audit_logger().info("pdpl_delete employee_id=42 ...")``
    so the line lands in ``audit.log`` instead of ``app.log``.
    """

    return logging.getLogger("maugood.audit")
