#!/bin/sh
# Hadir backend container entrypoint.
# Runs Alembic migrations as the admin role, then starts Uvicorn as the
# restricted app role. Migrations are idempotent — re-running a container
# after the DB is already at head is a no-op.
set -e

echo "[entrypoint] Running Alembic migrations..."
alembic upgrade head

echo "[entrypoint] Starting Uvicorn on :8000"
exec uvicorn hadir.main:app --host 0.0.0.0 --port 8000 --reload
