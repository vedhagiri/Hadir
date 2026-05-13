"""0054 — Add recording_status column to person_clips.

Phase D — live-recording UX. The reader now INSERTs a person_clips
row at clip *start* with recording_status='recording' so the
PersonClipsPage can render a live row immediately. ClipWorker
UPDATEs the same row to 'completed' on finalize (or 'failed' on
encode error). A startup janitor sweeps any 'recording' rows left
by an unclean shutdown to 'abandoned'.

Values:
* recording  — clip in progress, file_path may still be NULL.
* completed  — file on disk, fully encoded.
* failed     — encode/merge failed; file may be missing.
* abandoned  — process crashed mid-clip (janitor-set).

Existing rows are migrated to 'completed' since they predate this
column and (by definition) have a final file_path. The CHECK
constraint prevents future drift into unknown states.

Revision ID: 0054_recording_status
Revises: 0053_body_default
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0054_recording_status"
down_revision: Union[str, None] = "0053_body_default"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person_clips",
        sa.Column(
            "recording_status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'completed'"),
        ),
    )
    op.create_check_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        "recording_status IN ('recording', 'completed', 'failed', 'abandoned')",
    )
    # Partial-ish index — most rows are 'completed' so the index is
    # small but the queries it accelerates ("show me live clips for
    # this tenant") hit only the few non-completed rows.
    op.create_index(
        "ix_person_clips_tenant_recording_status",
        "person_clips",
        ["tenant_id", "recording_status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_person_clips_tenant_recording_status",
        table_name="person_clips",
    )
    op.drop_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        type_="check",
    )
    op.drop_column("person_clips", "recording_status")
