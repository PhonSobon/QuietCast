import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS recordings (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    filename       TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL,
    duration_sec   REAL NOT NULL DEFAULT 0,
    mode           TEXT NOT NULL DEFAULT 'screen',
    width          INTEGER,
    height         INTEGER,
    has_thumbnail  INTEGER NOT NULL DEFAULT 0,
    mp4_filename   TEXT,
    convert_status TEXT NOT NULL DEFAULT 'none',
    created_at     TEXT NOT NULL
);
"""

# Columns added after the first release (migrated in place)
EXTRA_COLUMNS = {
    "denoised_filename": "TEXT",
    "denoise_status": "TEXT NOT NULL DEFAULT 'none'",
    "denoise_error": "TEXT",
    "transcript_status": "TEXT NOT NULL DEFAULT 'none'",
    "transcript_error": "TEXT",
    "transcript_text": "TEXT",
}


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(recordings)")}
        for name, decl in EXTRA_COLUMNS.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE recordings ADD COLUMN {name} {decl}")
        # Jobs interrupted by a server restart will never finish
        conn.execute(
            "UPDATE recordings SET convert_status = 'failed' WHERE convert_status = 'processing'"
        )
        conn.execute(
            "UPDATE recordings SET denoise_status = 'failed', denoise_error = 'Interrupted by server restart' "
            "WHERE denoise_status = 'processing'"
        )
        conn.execute(
            "UPDATE recordings SET transcript_status = 'failed', transcript_error = 'Interrupted by server restart' "
            "WHERE transcript_status = 'processing'"
        )


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None
