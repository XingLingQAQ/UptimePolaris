CREATE TABLE IF NOT EXISTS auth_login_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_login_limits_window_started
  ON auth_login_limits(window_started);

CREATE TABLE IF NOT EXISTS auth_setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT
);

INSERT INTO auth_setup_state (id, completed, claim_id)
SELECT 1,
  CASE WHEN EXISTS (
    SELECT 1 FROM users
  ) THEN 1 ELSE 0 END,
  NULL
WHERE NOT EXISTS (SELECT 1 FROM auth_setup_state WHERE id = 1);
