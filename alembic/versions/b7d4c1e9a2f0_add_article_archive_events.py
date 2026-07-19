"""新增文章归档终态事件表。

Revision ID: b7d4c1e9a2f0
Revises: 8852af085998
Create Date: 2026-07-19 14:00:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7d4c1e9a2f0"
down_revision: Union[str, Sequence[str], None] = "8852af085998"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "article_archive_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("url_fingerprint", sa.String(length=16), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("reason", sa.String(length=64), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=True),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_article_archive_events_occurred_at"),
        "article_archive_events",
        ["occurred_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_article_archive_events_status"),
        "article_archive_events",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_article_archive_events_url_fingerprint"),
        "article_archive_events",
        ["url_fingerprint"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_article_archive_events_url_fingerprint"),
        table_name="article_archive_events",
    )
    op.drop_index(
        op.f("ix_article_archive_events_status"), table_name="article_archive_events"
    )
    op.drop_index(
        op.f("ix_article_archive_events_occurred_at"),
        table_name="article_archive_events",
    )
    op.drop_table("article_archive_events")
