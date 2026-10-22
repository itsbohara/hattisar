-- Ids are Studio's deterministic uuids, the same in every project for the same name, so they are
-- only unique per project.
CREATE TABLE snippet_folders (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, name)
);

CREATE TABLE snippets (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, folder_id, name),
  FOREIGN KEY (project_id, folder_id) REFERENCES snippet_folders (project_id, id) ON DELETE CASCADE
);

-- UNIQUE treats NULLs as distinct, so root snippets need their own index.
CREATE UNIQUE INDEX snippets_root_name ON snippets (project_id, name) WHERE folder_id IS NULL;
