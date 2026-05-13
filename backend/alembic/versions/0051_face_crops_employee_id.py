"""0051 — Add employee_id to face_crops.

Revision ID: 0051_face_crops_employee_id
Revises: 0050_face_crops_use_case
Create Date: 2026-05-12

Links each saved face crop to the employee that was matched for it
(NULL = unidentified / unknown person).  ON DELETE SET NULL so hard-
deleting an employee leaves the crop rows intact but clears attribution.
"""

import sqlalchemy as sa
from alembic import op

revision = "0051_face_crops_employee_id"
down_revision = "0050_face_crops_use_case"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "face_crops",
        sa.Column("employee_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_face_crops_employee_id",
        "face_crops",
        "employees",
        ["employee_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_face_crops_employee_id",
        "face_crops",
        ["tenant_id", "employee_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_face_crops_employee_id", table_name="face_crops")
    op.drop_constraint("fk_face_crops_employee_id", "face_crops", type_="foreignkey")
    op.drop_column("face_crops", "employee_id")
