CREATE TABLE IF NOT EXISTS research_imports (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL UNIQUE,
  source_filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  metadata_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS player_research (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  import_id TEXT NOT NULL REFERENCES research_imports(id),
  espn_rank INTEGER NOT NULL CHECK (espn_rank > 0),
  recommended_round INTEGER,
  planned_pick INTEGER,
  phase TEXT NOT NULL,
  archetype TEXT NOT NULL,
  opportunity REAL NOT NULL CHECK (opportunity BETWEEN 0 AND 10),
  role_clarity REAL NOT NULL CHECK (role_clarity BETWEEN 0 AND 10),
  vision_score REAL NOT NULL,
  model_signal TEXT NOT NULL,
  user_tag TEXT NOT NULL,
  injury_news TEXT NOT NULL,
  why_fits TEXT NOT NULL,
  failure_case TEXT NOT NULL,
  alternatives TEXT NOT NULL,
  pairing_construction TEXT NOT NULL,
  earliest_pick INTEGER,
  target_pick INTEGER,
  latest_pick INTEGER,
  espn_source TEXT NOT NULL,
  adp_source TEXT NOT NULL,
  analysis_source TEXT NOT NULL,
  imported_draft_status TEXT NOT NULL,
  researched_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS player_research_import ON player_research(import_id, player_id);
