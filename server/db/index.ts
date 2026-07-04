import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBeesDbPath, ensureBeesStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureBeesStateDirs();

const dbPath = resolveBeesDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);
ensureTaskSchema(db);
ensureProjectSchema(db);
normalizeOrganizationPendingTaskStatuses(db);

function ensureTaskSchema(database: import('better-sqlite3').Database): void {
  const expectedColumns = new Map<string, string>([
    ['task_kind', "TEXT NOT NULL DEFAULT 'task'"],
    ['task_mode', "TEXT NOT NULL DEFAULT 'direct'"],
    ['workspace_path', 'TEXT'],
    ['organization_id', 'TEXT'],
    ['creator_developer_id', 'TEXT'],
    ['creator_email', 'TEXT'],
    ['creator_first_name', 'TEXT'],
    ['creator_last_name', 'TEXT'],
    ['team_id', 'TEXT'],
    ['team_name', 'TEXT'],
    ['assignee_developer_id', 'TEXT'],
    ['assignee_email', 'TEXT'],
    ['assignee_first_name', 'TEXT'],
    ['assignee_last_name', 'TEXT'],
    ['agent_runtime', 'TEXT'],
    ['agent_model', 'TEXT'],
    ['reasoning_effort', 'TEXT'],
    ['last_agent_response_at', 'INTEGER'],
    ['last_viewed_at', 'INTEGER'],
    ['last_context_used_tokens', 'INTEGER'],
    ['last_context_window_tokens', 'INTEGER'],
  ]);
  const existingColumns = new Set<string>(
    (
      database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all() as Array<{ name: string }>
    ).map(column => column.name),
  );

  for (const [columnName, columnType] of expectedColumns) {
    if (existingColumns.has(columnName)) continue;
    database.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${columnType}`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_organization_id ON tasks(organization_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_creator_developer_id ON tasks(creator_developer_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_developer_id ON tasks(assignee_developer_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id);
  `);
}

function ensureProjectSchema(database: import('better-sqlite3').Database): void {
  const expectedColumns = new Map<string, string>([
    ['organization_id', 'TEXT'],
    ['creator_developer_id', 'TEXT'],
  ]);
  const existingColumns = new Set<string>(
    (
      database
        .prepare("SELECT name FROM pragma_table_info('projects')")
        .all() as Array<{ name: string }>
    ).map(column => column.name),
  );

  for (const [columnName, columnType] of expectedColumns) {
    if (existingColumns.has(columnName)) continue;
    database.exec(`ALTER TABLE projects ADD COLUMN ${columnName} ${columnType}`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id);
    CREATE INDEX IF NOT EXISTS idx_projects_creator_developer_id ON projects(creator_developer_id);
  `);
}

function normalizeOrganizationPendingTaskStatuses(database: import('better-sqlite3').Database): void {
  const migrationKey = 'migration:organization-pending-to-assigned:v1';
  const existing = database
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(migrationKey) as { value: string | null } | undefined;
  if (existing) return;

  database
    .prepare(`
      UPDATE tasks
      SET status = 'assigned', updated_at = @updated_at
      WHERE status = 'pending'
        AND organization_id IS NOT NULL
        AND TRIM(organization_id) <> ''
    `)
    .run({ updated_at: Date.now() });
  database
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run(migrationKey, new Date().toISOString());
}

export default db;
