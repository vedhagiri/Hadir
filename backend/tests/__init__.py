"""Backend test suite. Run inside the backend container:

    docker compose exec backend pytest -q

Tests run against the live compose Postgres (no separate test DB in pilot
scope). Fixtures create/remove rows through the admin engine so they have
the same grants as migrations.
"""
