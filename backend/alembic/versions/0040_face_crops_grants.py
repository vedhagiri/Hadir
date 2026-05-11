"""Grant maugood_app permissions on face_crops table.

Revision ID: 0040_face_crops_grants
Revises: 0039_face_crops
Create Date: 2026-05-08
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0040_face_crops_grants"
down_revision: Union[str, None] = "0039_face_crops"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE face_crops OWNER TO maugood_admin")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON face_crops TO maugood_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE face_crops_id_seq TO maugood_app")


def downgrade() -> None:
    pass
