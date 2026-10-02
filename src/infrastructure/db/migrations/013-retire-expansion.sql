-- cyclosa: foreign-keys-off
CREATE TABLE run_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import','extract','research','consolidate')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','partial','cancelled','failed')),
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  topic TEXT,
  providers_json TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  ended_reason TEXT CHECK (ended_reason IS NULL OR ended_reason IN ('shutdown', 'stale')),
  research_id TEXT REFERENCES research(id) ON DELETE SET NULL,
  unpriced INTEGER NOT NULL DEFAULT 0,
  task_costs_json TEXT
);
INSERT INTO run_new (
  id, kind, status, succeeded, failed, correlation_id, started_at, ended_at, created_at,
  label, total, error_code, topic, providers_json, requests, cost_usd, ended_reason,
  research_id, unpriced, task_costs_json
)
SELECT id, CASE WHEN kind = 'expand' THEN 'extract' ELSE kind END,
  status, succeeded, failed, correlation_id, started_at, ended_at, created_at,
  label, total, error_code, topic, providers_json, requests, cost_usd, ended_reason,
  research_id, unpriced, task_costs_json
FROM run;
DROP TABLE run;
ALTER TABLE run_new RENAME TO run;
CREATE INDEX idx_run_created ON run(created_at DESC);
CREATE INDEX idx_run_research ON run(research_id) WHERE research_id IS NOT NULL;
DROP TABLE run_angle;
