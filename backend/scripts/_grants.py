"""Schema-grants reconciliation — the single source of truth.

For every per-tenant schema, ``maugood_admin`` must own every table and
``maugood_app`` must hold the correct GRANTs (SELECT+INSERT+UPDATE+DELETE
on every table except ``audit_log``, which is INSERT+SELECT only — the
append-only invariant from P2). Sequences need USAGE+SELECT; default
privileges keep future sequences covered without another sync pass.

``sync_schema_grants(conn, schema_name)`` enforces that contract
idempotently against any schema. The table list is discovered from
``information_schema.tables`` so new tables created by future
migrations are picked up automatically — there is no static allowlist
to keep in sync with metadata.

Called from three places (single source of truth):

* ``scripts.migrate`` — after every ``alembic upgrade head`` against a
  tenant schema. Catches anything a forward migration created without
  its own GRANT block.
* ``scripts.sync_grants`` — operator CLI for one-shot recovery across
  every tenant in ``public.tenants``.
* ``scripts.provision_tenant`` — at provisioning time, against the
  fresh tenant schema.

Red lines:

* ``audit_log`` is append-only at the grant level. UPDATE / DELETE /
  TRUNCATE are explicitly REVOKEd from ``maugood_app`` on every pass to
  fix any historical drift. Only SELECT + INSERT remain.
* ``alembic_version`` ownership is transferred to ``maugood_admin`` for
  hygiene; ``maugood_app`` is REVOKEd from it (the request path never
  reads migration state).
* The helper assumes the connection is running as a role that can ALTER
  OWNER on every table in the schema. In practice this is the
  bootstrap superuser via ``MAUGOOD_ADMIN_DATABASE_URL``.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.engine import Connection

logger = logging.getLogger("maugood.grants")

_APPEND_ONLY_TABLE = "audit_log"
_NO_APP_GRANT_TABLES = ("alembic_version",)


def _list_schema_tables(conn: Connection, schema_name: str) -> list[str]:
    rows = conn.execute(
        text(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = :s AND table_type = 'BASE TABLE' "
            "ORDER BY table_name"
        ),
        {"s": schema_name},
    ).all()
    return [str(r.table_name) for r in rows]


def sync_schema_grants(conn: Connection, schema_name: str) -> dict[str, int]:
    """Re-apply the ownership + grant contract to ``schema_name``.

    Idempotent. Returns a summary dict the caller can log:
    ``{"tables": N, "full_crud": N, "append_only": N, "admin_only": N}``.

    All work runs inside the caller's transaction so a failure rolls
    back cleanly. The caller (``scripts.migrate``, ``scripts.sync_grants``,
    ``scripts.provision_tenant``) controls commit.
    """

    conn.execute(text(f'ALTER SCHEMA "{schema_name}" OWNER TO maugood_admin'))
    conn.execute(text(f'GRANT USAGE ON SCHEMA "{schema_name}" TO maugood_app'))

    tables = _list_schema_tables(conn, schema_name)

    full_crud_count = 0
    append_only_count = 0
    admin_only_count = 0

    for tbl in tables:
        conn.execute(
            text(f'ALTER TABLE "{schema_name}"."{tbl}" OWNER TO maugood_admin')
        )

        if tbl == _APPEND_ONLY_TABLE:
            conn.execute(
                text(
                    f'REVOKE UPDATE, DELETE, TRUNCATE '
                    f'ON "{schema_name}"."{tbl}" FROM maugood_app'
                )
            )
            conn.execute(
                text(
                    f'GRANT SELECT, INSERT '
                    f'ON "{schema_name}"."{tbl}" TO maugood_app'
                )
            )
            append_only_count += 1
        elif tbl in _NO_APP_GRANT_TABLES:
            conn.execute(
                text(
                    f'REVOKE ALL ON "{schema_name}"."{tbl}" FROM maugood_app'
                )
            )
            admin_only_count += 1
        else:
            conn.execute(
                text(
                    f'GRANT SELECT, INSERT, UPDATE, DELETE '
                    f'ON "{schema_name}"."{tbl}" TO maugood_app'
                )
            )
            full_crud_count += 1

    conn.execute(
        text(
            f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "{schema_name}" '
            f'TO maugood_app'
        )
    )
    conn.execute(
        text(
            f'ALTER DEFAULT PRIVILEGES IN SCHEMA "{schema_name}" '
            f'GRANT USAGE, SELECT ON SEQUENCES TO maugood_app'
        )
    )

    logger.info(
        "grants synced: schema=%s tables=%d "
        "(crud=%d, append_only=%d, admin_only=%d)",
        schema_name,
        len(tables),
        full_crud_count,
        append_only_count,
        admin_only_count,
    )

    return {
        "tables": len(tables),
        "full_crud": full_crud_count,
        "append_only": append_only_count,
        "admin_only": admin_only_count,
    }
