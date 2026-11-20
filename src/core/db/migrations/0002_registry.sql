-- M2: model registry bookkeeping.

ALTER TABLE models ADD COLUMN model_id TEXT NOT NULL DEFAULT '';             -- raw provider model id
ALTER TABLE models ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0;             -- appeared after the first sync
ALTER TABLE models ADD COLUMN quality_override_json TEXT NOT NULL DEFAULT '{}'; -- user edits, survive syncs
ALTER TABLE models ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';          -- modalities, supported params
ALTER TABLE models ADD COLUMN latency_samples_json TEXT NOT NULL DEFAULT '[]'; -- recent latencies for p50
ALTER TABLE models ADD COLUMN last_tested_at INTEGER;

CREATE INDEX idx_models_state ON models(state);

CREATE TABLE registry_sync (
  provider_id     TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error      TEXT,
  success_count   INTEGER NOT NULL DEFAULT 0
);
