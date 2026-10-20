CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE boxes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('shared', 'registered', 'managed')),
  dev_only INTEGER NOT NULL CHECK (dev_only IN (0, 1)),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  admin_user TEXT NOT NULL,
  admin_password_enc TEXT NOT NULL,
  sslmode TEXT NOT NULL,
  public_host TEXT NOT NULL,
  public_port INTEGER NOT NULL,
  pooler_tenant TEXT,
  pooler_session_port INTEGER,
  pooler_transaction_port INTEGER,
  container_name TEXT,
  created_at TEXT NOT NULL
);

-- §5: exactly one shared box.
CREATE UNIQUE INDEX boxes_one_shared ON boxes (kind) WHERE kind = 'shared';

-- projects.box_id has no ON DELETE action: a box with projects (any status) cannot be removed.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  box_id INTEGER NOT NULL REFERENCES boxes (id),
  db_name TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  owner_password_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  deleted_at TEXT,
  deleted_db_name TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX projects_box_id ON projects (box_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE backup_schedules (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK (frequency IN ('off', 'daily', 'weekly')),
  keep_daily INTEGER NOT NULL,
  keep_weekly INTEGER NOT NULL
);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  s3_key TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX backups_project_id_created_at ON backups (project_id, created_at);
