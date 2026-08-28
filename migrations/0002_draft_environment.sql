CREATE TABLE IF NOT EXISTS application_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  draft_environment TEXT NOT NULL CHECK (draft_environment IN ('PRACTICE','LIVE')),
  updated_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO application_settings(singleton, draft_environment, updated_at)
VALUES (1, 'PRACTICE', '2026-08-27T00:00:00.000Z');
