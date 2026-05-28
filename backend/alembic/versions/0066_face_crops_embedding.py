"""Add embedding column to face_crops.

Fernet-encrypted 512-float32 InsightFace embedding, stored at extraction
time so the clip-pipeline fan-out into ``detection_events`` can copy it
without recomputing.  Unidentified Faces → Similarity Groups depends on
``detection_events.embedding`` for cosine clustering; the prior reprocess
flow dropped the embedding on the floor, leaving every recent
unidentified event un-clusterable.

Nullable so legacy rows + crops whose embedding extraction failed survive.

Revision ID: 0066_face_crops_embedding
Revises:     0065_fix_requests_escalation
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0066_face_crops_embedding"
down_revision: str = "0065_fix_requests_escalation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: ``IF NOT EXISTS`` so re-running on a schema that
    # already has the column (e.g. a fresh ``metadata.create_all``-
    # provisioned tenant) is a no-op.
    op.execute(
        "ALTER TABLE face_crops "
        "ADD COLUMN IF NOT EXISTS embedding BYTEA NULL"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE face_crops DROP COLUMN IF EXISTS embedding")
