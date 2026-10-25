ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'created' CHECK (kind IN ('created', 'attached'));
ALTER TABLE projects ADD COLUMN login_superuser INTEGER NOT NULL DEFAULT 0;
