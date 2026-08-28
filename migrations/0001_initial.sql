PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('QB','RB','WR','TE','K','DST')),
  team TEXT,
  bye_week INTEGER CHECK (bye_week IS NULL OR bye_week BETWEEN 4 AND 15),
  overall_rank INTEGER NOT NULL CHECK (overall_rank > 0),
  positional_rank INTEGER NOT NULL CHECK (positional_rank > 0),
  adp REAL,
  projection REAL NOT NULL,
  upside REAL NOT NULL CHECK (upside BETWEEN 0 AND 100),
  reliability REAL NOT NULL CHECK (reliability BETWEEN 0 AND 100),
  risk REAL NOT NULL CHECK (risk BETWEEN 0 AND 100),
  tier INTEGER NOT NULL CHECK (tier > 0),
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0,1))
) STRICT;

CREATE INDEX IF NOT EXISTS players_rank ON players(overall_rank, id);
CREATE INDEX IF NOT EXISTS players_position_rank ON players(position, positional_rank, id);

CREATE TABLE IF NOT EXISTS external_identities (
  source_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, namespace, external_id, scope_key)
) STRICT;

CREATE TABLE IF NOT EXISTS league_config_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
) STRICT;

CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
) STRICT;

CREATE TABLE IF NOT EXISTS draft_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('PRACTICE','REAL','SIMULATED','REPLAY')),
  state TEXT NOT NULL CHECK (state IN ('DRAFT','ACTIVE','COMPLETED','ARCHIVED','RESET_ARCHIVED','DELETED')),
  external_platform TEXT,
  external_draft_id TEXT,
  league_config_version_id TEXT NOT NULL REFERENCES league_config_versions(id),
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
  parent_session_id TEXT REFERENCES draft_sessions(id),
  restored_from_session_id TEXT REFERENCES draft_sessions(id),
  user_slot INTEGER NOT NULL CHECK (user_slot > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS one_external_draft_per_platform
ON draft_sessions(external_platform, external_draft_id)
WHERE external_draft_id IS NOT NULL AND state <> 'DELETED';

CREATE TABLE IF NOT EXISTS pick_revisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES draft_sessions(id),
  overall_pick INTEGER NOT NULL CHECK (overall_pick > 0),
  player_id TEXT NOT NULL REFERENCES players(id),
  drafting_slot INTEGER NOT NULL CHECK (drafting_slot > 0),
  authority TEXT NOT NULL CHECK (authority IN ('manual','snapshot','structured','dom','simulator')),
  action TEXT NOT NULL CHECK (action IN ('ADD','CORRECT','UNLOCK')),
  observation_id TEXT,
  supersedes_revision_id TEXT REFERENCES pick_revisions(id),
  reason TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS draft_picks (
  session_id TEXT NOT NULL REFERENCES draft_sessions(id),
  overall_pick INTEGER NOT NULL CHECK (overall_pick > 0),
  player_id TEXT NOT NULL REFERENCES players(id),
  drafting_slot INTEGER NOT NULL CHECK (drafting_slot > 0),
  authority TEXT NOT NULL CHECK (authority IN ('manual','snapshot','structured','dom','simulator')),
  locked_manual INTEGER NOT NULL DEFAULT 0 CHECK (locked_manual IN (0,1)),
  accepted_revision_id TEXT NOT NULL UNIQUE REFERENCES pick_revisions(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  selected_at TEXT NOT NULL,
  PRIMARY KEY (session_id, overall_pick),
  UNIQUE (session_id, player_id)
) STRICT;

CREATE TABLE IF NOT EXISTS draft_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES draft_sessions(id),
  mechanism TEXT NOT NULL,
  kind TEXT NOT NULL,
  adapter_schema_version TEXT NOT NULL,
  external_draft_id TEXT,
  observed_at TEXT NOT NULL,
  monotonic_seq INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_inline TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  UNIQUE(session_id, dedupe_key)
) STRICT;

CREATE TABLE IF NOT EXISTS reconciliation_conflicts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES draft_sessions(id),
  overall_pick INTEGER NOT NULL,
  candidate_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED','DISMISSED')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS recommendation_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES draft_sessions(id),
  session_revision INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  strategy_version_id TEXT NOT NULL REFERENCES strategy_versions(id),
  cause TEXT NOT NULL,
  results_json TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, session_revision, algorithm_version)
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  undo_of_id TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS command_results (
  command_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_session_id TEXT REFERENCES draft_sessions(id),
  updated_at TEXT NOT NULL
) STRICT;
