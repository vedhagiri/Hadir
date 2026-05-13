"""0056 — Faster clip encoding defaults.

Operator feedback: clip finalize takes real wall-clock minutes on
multi-megapixel cameras. The pre-0056 defaults
(CRF=23 / preset=fast / resolution=native) encode at near-real-time
on a 2560×1440 25 fps source — a 4 min clip ≈ 4 min of encoding,
landing as a 400+ MB MP4.

This migration bumps the tenant defaults so surveillance clips
encode much faster at quality that's still well above what a 720p
person-presence review needs:

  * ``video_crf``              23  → 26   (~15-20% smaller file)
  * ``video_preset``           fast → veryfast  (~30-40% faster encode)
  * ``resolution_max_height``  null → 720       (~4× faster encode +
                                                 ~5× smaller file)

Combined: ~6-10× faster encoding for the typical 1440p source.
``chunk_duration_sec`` + ``keep_chunks_after_merge`` are unchanged.

Existing tenant rows that still hold ALL of the pre-0056 defaults
are bumped to the new defaults; rows where an operator has already
tuned ANY key are left alone (their intent is honoured). The
System Settings UI continues to let operators override.

Revision ID: 0056_encoding_faster
Revises: 0055_finalizing_state
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0056_encoding_faster"
down_revision: Union[str, None] = "0055_finalizing_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_OLD_DEFAULT = (
    '{"chunk_duration_sec": 180, '
    '"video_crf": 23, '
    '"video_preset": "fast", '
    '"resolution_max_height": null, '
    '"keep_chunks_after_merge": false}'
)
_NEW_DEFAULT = (
    '{"chunk_duration_sec": 180, '
    '"video_crf": 26, '
    '"video_preset": "veryfast", '
    '"resolution_max_height": 720, '
    '"keep_chunks_after_merge": false}'
)


def upgrade() -> None:
    # Bump the server_default for any tenant_settings row created
    # going forward.
    op.alter_column(
        "tenant_settings",
        "clip_encoding_config",
        server_default=sa.text(f"'{_NEW_DEFAULT}'::jsonb"),
    )

    # Migrate existing rows that still hold ALL pre-0056 defaults.
    # The equality check on the whole JSONB object means we only
    # touch rows that an operator has NEVER tuned — any change
    # (different CRF, different resolution, etc.) leaves the row
    # alone. Postgres JSONB equality is key-order-insensitive.
    op.execute(
        f"UPDATE tenant_settings "
        f"SET clip_encoding_config = '{_NEW_DEFAULT}'::jsonb "
        f"WHERE clip_encoding_config = '{_OLD_DEFAULT}'::jsonb"
    )


def downgrade() -> None:
    op.alter_column(
        "tenant_settings",
        "clip_encoding_config",
        server_default=sa.text(f"'{_OLD_DEFAULT}'::jsonb"),
    )
    op.execute(
        f"UPDATE tenant_settings "
        f"SET clip_encoding_config = '{_OLD_DEFAULT}'::jsonb "
        f"WHERE clip_encoding_config = '{_NEW_DEFAULT}'::jsonb"
    )
