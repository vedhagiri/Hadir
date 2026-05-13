"""0055 — Allow 'finalizing' on person_clips.recording_status.

Operator-visible symptom that drove this: two ``recording`` rows on
the same camera at the same time. Caused by the encode window: the
reader hands off a clip and immediately frees up to start the next
one, while ClipWorker is still encoding the previous clip in a
background thread. Until that ClipWorker UPDATE lands, the DB row
remains ``recording``. For long clips (multi-minute), encoding can
take real wall-clock minutes — and the next clip can absolutely
start in that window.

This migration adds ``finalizing`` so we can distinguish:

* ``recording``  — reader is actively writing chunk frames to disk
* ``finalizing`` — reader has handed off; ClipWorker is encoding +
                   merging + Fernet-encrypting the file
* ``completed``  — file on disk, ClipWorker UPDATE landed
* ``failed``     — encode / write error
* ``abandoned``  — startup janitor swept a stale 'recording' row

The frontend renders ``finalizing`` as a yellow "Encoding…" pill
instead of the red LIVE badge so the operator sees the file is
being prepared, not actively recording.

Revision ID: 0055_finalizing_state
Revises: 0054_recording_status
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0055_finalizing_state"
down_revision: Union[str, None] = "0054_recording_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        type_="check",
    )
    op.create_check_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        "recording_status IN "
        "('recording', 'finalizing', 'completed', 'failed', 'abandoned')",
    )


def downgrade() -> None:
    # Flip any stale 'finalizing' rows to 'failed' before tightening
    # the constraint back to the pre-0055 set — otherwise an existing
    # 'finalizing' row would block the constraint recreation.
    op.execute(
        "UPDATE person_clips SET recording_status = 'failed' "
        "WHERE recording_status = 'finalizing'"
    )
    op.drop_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        type_="check",
    )
    op.create_check_constraint(
        "ck_person_clips_recording_status",
        "person_clips",
        "recording_status IN ('recording', 'completed', 'failed', 'abandoned')",
    )
