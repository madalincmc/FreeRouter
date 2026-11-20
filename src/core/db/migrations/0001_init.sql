-- PRD §10 – initial schema. Keys are stored only as DPAPI ciphertext (never plaintext).

CREATE TABLE providers (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  base_url             TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  profile_json         TEXT NOT NULL DEFAULT '{}',
  limit_overrides_json TEXT NOT NULL DEFAULT '{}',
  may_train_on_data    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  ciphertext  BLOB NOT NULL,
  masked      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('valid', 'invalid', 'untested')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER
);
CREATE INDEX idx_api_keys_provider ON api_keys(provider_id);

CREATE TABLE models (
  id             TEXT PRIMARY KEY, -- "<provider>/<model_id>"
  provider_id    TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  display_name   TEXT NOT NULL,
  is_free        INTEGER NOT NULL DEFAULT 0,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  quality_json   TEXT NOT NULL DEFAULT '{}',
  context_window INTEGER,
  max_output     INTEGER,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  missed_syncs   INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'healthy'
                 CHECK (state IN ('healthy', 'degraded', 'cooling_down', 'quota_exhausted', 'gone')),
  cooldown_until INTEGER,
  last_error     TEXT
);
CREATE INDEX idx_models_provider ON models(provider_id);

CREATE TABLE usage_counters (
  key_id       TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  window       TEXT NOT NULL CHECK (window IN ('minute', 'day')),
  window_start INTEGER NOT NULL,
  requests     INTEGER NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model_id, window, window_start)
);

CREATE TABLE request_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('chat', 'gateway')),
  client_ua         TEXT,
  requested_model   TEXT,
  chosen_model      TEXT,
  attempts_json     TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL,
  latency_ms        INTEGER,
  ttft_ms           INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  error             TEXT
);
CREATE INDEX idx_request_log_ts ON request_log(ts);

CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT 'New chat',
  pinned_model TEXT,
  private_mode INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content         TEXT NOT NULL,
  model_used      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE chains (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  model_ids TEXT NOT NULL DEFAULT '[]' -- ordered JSON array of "<provider>/<model_id>"
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
