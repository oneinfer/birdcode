CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  task_kind         TEXT NOT NULL DEFAULT 'task',
  task_mode         TEXT NOT NULL DEFAULT 'direct',
  workspace_path    TEXT,
  organization_id   TEXT,
  creator_developer_id TEXT,
  creator_email     TEXT,
  creator_first_name TEXT,
  creator_last_name TEXT,
  team_id           TEXT,
  team_name         TEXT,
  assignee_developer_id TEXT,
  assignee_email    TEXT,
  assignee_first_name TEXT,
  assignee_last_name TEXT,
  agent_runtime     TEXT,
  agent_model       TEXT,
  reasoning_effort  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_agent_response_at  INTEGER,
  last_viewed_at    INTEGER,
  last_context_used_tokens   INTEGER,
  last_context_window_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS projects (
  path              TEXT PRIMARY KEY,
  label             TEXT,
  organization_id   TEXT,
  creator_developer_id TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key               TEXT PRIMARY KEY,
  value             TEXT
);

CREATE TABLE IF NOT EXISTS task_messages (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  thinking          TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_messages_task_id_created_at ON task_messages(task_id, created_at);

CREATE TABLE IF NOT EXISTS activity_contexts (
  id                 TEXT PRIMARY KEY,
  source_event_id    TEXT,
  trigger            TEXT NOT NULL,
  spoken_input       TEXT,
  captured_text      TEXT,
  active_window_json TEXT,
  images_json        TEXT,
  decision_json      TEXT,
  promoted_task_id   TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (promoted_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_contexts_created_at ON activity_contexts(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_contexts_source_event_id ON activity_contexts(source_event_id);
