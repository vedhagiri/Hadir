"""Add embedding BYTEA NULL to employee_photos.

The embedding is a 512-float-32 InsightFace buffalo_l recognition
vector (L2-normalised), Fernet-encrypted at rest because biometric
data falls under PDPL (PROJECT_CONTEXT §12). The matcher decrypts into
an in-memory cache at request time; the plaintext vector never hits
disk.

Revision ID: 0005_photo_embeddings
Revises: 0004_capture
Create Date: 2026-04-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_photo_embeddings"
down_revision: Union[str, Sequence[str], None] = "0004_capture"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SCHEMA = "main"


def upgrade() -> None:
    op.add_column(
        "employee_photos",
        sa.Column("embedding", sa.LargeBinary(), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column("employee_photos", "embedding", schema=SCHEMA)
