import { v4 as uuid } from 'uuid';
import db from './index.js';
import {
  type Task,
  type TaskStatus,
  type TaskKind,
  type TaskMode,
  type ReasoningEffort,
  type ContextUsage,
  type AgentRuntime,
  type TaskMessage,
  type Project,
  type ActivityContext,
  type ActivityIntentDecision,
} from '../../shared/types.js';
import type { VisibilityParams } from '../organization-access.js';

const stmtAllProjects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC');
const stmtGetProject = db.prepare('SELECT * FROM projects WHERE path = ?');
const stmtDeleteProject = db.prepare('DELETE FROM projects WHERE path = ?');
const stmtInsertProject = db.prepare(`
  INSERT INTO projects (path, label, organization_id, creator_developer_id, created_at, updated_at)
  VALUES (@path, @label, @organization_id, @creator_developer_id, @created_at, @updated_at)
  ON CONFLICT(path) DO UPDATE SET
    label = excluded.label,
    organization_id = excluded.organization_id,
    creator_developer_id = excluded.creator_developer_id,
    updated_at = excluded.updated_at
`);
const stmtAllTasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC');
const stmtTasksByStatus = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC');
const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
const stmtRecentTaskByDescription = db.prepare('SELECT * FROM tasks WHERE description = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1');
const stmtTaskIdsByWorkspacePath = db.prepare('SELECT id FROM tasks WHERE workspace_path = ?');
const stmtInsertTask = db.prepare(`
  INSERT INTO tasks (
    id, title, description, status, task_kind, task_mode, workspace_path,
    organization_id, creator_developer_id, creator_email, creator_first_name, creator_last_name,
    team_id, team_name, assignee_developer_id, assignee_email, assignee_first_name, assignee_last_name,
    agent_runtime, agent_model, reasoning_effort,
    created_at, updated_at, last_agent_response_at, last_viewed_at,
    last_context_used_tokens, last_context_window_tokens
  )
  VALUES (
    @id, @title, @description, @status, @task_kind, @task_mode, @workspace_path,
    @organization_id, @creator_developer_id, @creator_email, @creator_first_name, @creator_last_name,
    @team_id, @team_name, @assignee_developer_id, @assignee_email, @assignee_first_name, @assignee_last_name,
    @agent_runtime, @agent_model, @reasoning_effort,
    @created_at, @updated_at, @last_agent_response_at, @last_viewed_at,
    @last_context_used_tokens, @last_context_window_tokens
  )
`);
const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const stmtDeleteTasksByWorkspacePath = db.prepare('DELETE FROM tasks WHERE workspace_path = ?');
const stmtTouchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
const stmtClaimLegacyPersonalTasks = db.prepare(`
  UPDATE tasks
  SET creator_developer_id = @developer_id,
      creator_email = COALESCE(creator_email, @email),
      updated_at = @updated_at
  WHERE organization_id IS NULL
    AND creator_developer_id IS NULL
`);
const stmtMarkTaskViewed = db.prepare(`
  UPDATE tasks
  SET last_viewed_at = last_agent_response_at
  WHERE id = ?
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
`);
const stmtGetAppSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetAppSetting = db.prepare(`
  INSERT INTO app_settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const stmtDeleteAppSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');
const stmtGetTaskMessages = db.prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC');
const stmtInsertTaskMessage = db.prepare(`
  INSERT INTO task_messages (id, task_id, role, content, thinking, created_at)
  VALUES (@id, @task_id, @role, @content, @thinking, @created_at)
`);
const stmtAllActivityContexts = db.prepare('SELECT * FROM activity_contexts ORDER BY created_at DESC');
const stmtGetActivityContext = db.prepare('SELECT * FROM activity_contexts WHERE id = ?');
const stmtGetActivityContextBySourceEventId = db.prepare('SELECT * FROM activity_contexts WHERE source_event_id = ? ORDER BY created_at DESC LIMIT 1');
const stmtInsertActivityContext = db.prepare(`
  INSERT INTO activity_contexts (
    id, source_event_id, trigger, spoken_input, captured_text, active_window_json, images_json,
    decision_json, promoted_task_id, created_at, updated_at
  )
  VALUES (
    @id, @source_event_id, @trigger, @spoken_input, @captured_text, @active_window_json, @images_json,
    @decision_json, @promoted_task_id, @created_at, @updated_at
  )
`);
const stmtUpdateActivityContextPromotedTask = db.prepare(`
  UPDATE activity_contexts
  SET promoted_task_id = ?, updated_at = ?
  WHERE id = ?
`);
const stmtUpdateActivityContextDetails = db.prepare(`
  UPDATE activity_contexts
  SET trigger = @trigger, spoken_input = @spoken_input, captured_text = @captured_text,
      active_window_json = @active_window_json, images_json = @images_json, decision_json = @decision_json,
      updated_at = @updated_at
  WHERE id = @id
`);
const stmtDeleteActivityContext = db.prepare('DELETE FROM activity_contexts WHERE id = ?');

export function getAllProjects(): Project[] {
  return stmtAllProjects.all() as Project[];
}

export function getProject(path: string): Project | undefined {
  return stmtGetProject.get(path) as Project | undefined;
}

export function saveProject(project: {
  path: string;
  label?: string | null;
  organization_id?: string | null;
  creator_developer_id?: string | null;
}): Project {
  const now = Date.now();
  const existing = getProject(project.path);
  stmtInsertProject.run({
    path: project.path,
    label: project.label ?? existing?.label ?? null,
    organization_id: project.organization_id ?? existing?.organization_id ?? null,
    creator_developer_id: project.creator_developer_id ?? existing?.creator_developer_id ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return getProject(project.path) as Project;
}

export function deleteProject(path: string): { deleted: boolean; taskIds: string[] } {
  const taskIds = (stmtTaskIdsByWorkspacePath.all(path) as Array<{ id: string }>).map((row) => row.id);
  const result = db.transaction(() => {
    const deletedProject = stmtDeleteProject.run(path).changes > 0;
    if (taskIds.length > 0) stmtDeleteTasksByWorkspacePath.run(path);
    return deletedProject || taskIds.length > 0;
  })();
  return { deleted: result, taskIds };
}

export function getAllTasks(status?: TaskStatus): Task[] {
  return status ? stmtTasksByStatus.all(status) as Task[] : stmtAllTasks.all() as Task[];
}

const stmtPersonalTasks = db.prepare(`
  SELECT * FROM tasks
  WHERE creator_developer_id = @developerId AND organization_id IS NULL
  AND (:status IS NULL OR status = :status)
  ORDER BY updated_at DESC
`);

const stmtOrgTasksManager = db.prepare(`
  SELECT * FROM tasks
  WHERE organization_id = @organizationId
  AND (:status IS NULL OR status = :status)
  ORDER BY updated_at DESC
`);

const stmtOrgTasksMember = db.prepare(`
  SELECT * FROM tasks
  WHERE organization_id = @organizationId
  AND (:status IS NULL OR status = :status)
  AND (
    creator_developer_id = @developerId
    OR assignee_developer_id = @developerId
    OR (team_id IS NOT NULL AND team_id IN (SELECT value FROM json_each(@teamIdsJson)))
    OR (team_id IS NULL AND assignee_developer_id IS NULL)
  )
  ORDER BY updated_at DESC
`);

export function getVisibleTasks(params: VisibilityParams, status?: TaskStatus): Task[] {
  const statusParam = status ?? null;
  if (!params.organizationId) {
    return stmtPersonalTasks.all({ developerId: params.developerId, status: statusParam }) as Task[];
  }
  if (params.isManager) {
    return stmtOrgTasksManager.all({ organizationId: params.organizationId, status: statusParam }) as Task[];
  }
  return stmtOrgTasksMember.all({
    organizationId: params.organizationId,
    developerId: params.developerId,
    status: statusParam,
    teamIdsJson: JSON.stringify(Array.from(params.teamIds)),
  }) as Task[];
}

export function getTask(id: string): Task | undefined {
  return stmtGetTask.get(id) as Task | undefined;
}

export function getRecentTaskByDescription(description: string, since: number): Task | undefined {
  return stmtRecentTaskByDescription.get(description, since) as Task | undefined;
}

export function insertTask(task: {
  title: string;
  description?: string | null;
  status: TaskStatus;
  task_kind?: TaskKind | null;
  task_mode?: TaskMode | null;
  workspace_path?: string | null;
  organization_id?: string | null;
  creator_developer_id?: string | null;
  creator_email?: string | null;
  creator_first_name?: string | null;
  creator_last_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  assignee_developer_id?: string | null;
  assignee_email?: string | null;
  assignee_first_name?: string | null;
  assignee_last_name?: string | null;
  agent_runtime?: AgentRuntime | null;
  agent_model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  last_agent_response_at?: number | null;
}): Task {
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    task_kind: task.task_kind ?? 'task',
    task_mode: task.task_mode ?? 'direct',
    workspace_path: task.workspace_path ?? null,
    organization_id: task.organization_id ?? null,
    creator_developer_id: task.creator_developer_id ?? null,
    creator_email: task.creator_email ?? null,
    creator_first_name: task.creator_first_name ?? null,
    creator_last_name: task.creator_last_name ?? null,
    team_id: task.team_id ?? null,
    team_name: task.team_name ?? null,
    assignee_developer_id: task.assignee_developer_id ?? null,
    assignee_email: task.assignee_email ?? null,
    assignee_first_name: task.assignee_first_name ?? null,
    assignee_last_name: task.assignee_last_name ?? null,
    agent_runtime: task.agent_runtime ?? null,
    agent_model: task.agent_model ?? null,
    reasoning_effort: task.reasoning_effort ?? null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: task.last_agent_response_at ?? null,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
  };
  stmtInsertTask.run(row);
  return row as Task;
}

const ALLOWED_UPDATE_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'task_mode',
  'workspace_path',
  'organization_id',
  'creator_developer_id',
  'creator_email',
  'creator_first_name',
  'creator_last_name',
  'team_id',
  'team_name',
  'assignee_developer_id',
  'assignee_email',
  'assignee_first_name',
  'assignee_last_name',
  'agent_runtime',
  'agent_model',
  'reasoning_effort',
  'last_agent_response_at',
  'last_context_used_tokens',
  'last_context_window_tokens',
]);
const updateStmtCache = new Map<string, ReturnType<typeof db.prepare>>();

type TaskUpdateFields = Pick<
  Task,
  | 'title'
  | 'description'
  | 'status'
  | 'task_mode'
  | 'workspace_path'
  | 'organization_id'
  | 'creator_developer_id'
  | 'creator_email'
  | 'creator_first_name'
  | 'creator_last_name'
  | 'team_id'
  | 'team_name'
  | 'assignee_developer_id'
  | 'assignee_email'
  | 'assignee_first_name'
  | 'assignee_last_name'
  | 'agent_runtime'
  | 'agent_model'
  | 'reasoning_effort'
  | 'last_agent_response_at'
  | 'last_context_used_tokens'
  | 'last_context_window_tokens'
>;

function getUpdateStmt(fieldKeys: string[]): ReturnType<typeof db.prepare> {
  const key = fieldKeys.join(',');
  let stmt = updateStmtCache.get(key);
  if (!stmt) {
    const sets = fieldKeys.map(f => `${f} = @${f}`).join(', ');
    stmt = db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`);
    updateStmtCache.set(key, stmt);
  }
  return stmt;
}

export function updateTask(
  id: string,
  fields: Partial<TaskUpdateFields>,
): Task | undefined {
  const fieldKeys: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    fieldKeys.push(key);
    values[key] = value ?? null;
  }

  if (fieldKeys.length === 0) return getTask(id);

  values.updated_at = Date.now();
  getUpdateStmt(fieldKeys).run(values);
  return getTask(id);
}

export function touchTask(id: string): void {
  stmtTouchTask.run(Date.now(), id);
}

export function claimLegacyPersonalTasks(developerId: string, email: string | null): number {
  return stmtClaimLegacyPersonalTasks.run({
    developer_id: developerId,
    email,
    updated_at: Date.now(),
  }).changes;
}

export function contextFromTask(task: Task): ContextUsage | null {
  if (task.last_context_used_tokens == null || task.last_context_window_tokens == null) return null;
  return { used_tokens: task.last_context_used_tokens, window_tokens: task.last_context_window_tokens };
}

export function recordAgentResponse(taskId: string, at = Date.now(), context?: ContextUsage | null): Task | undefined {
  return updateTask(taskId, {
    last_agent_response_at: at,
    ...(context !== undefined ? {
      last_context_used_tokens: context?.used_tokens ?? null,
      last_context_window_tokens: context?.window_tokens ?? null,
    } : {}),
  });
}

export function markTaskViewed(id: string): { task: Task | undefined; changed: boolean } {
  const result = stmtMarkTaskViewed.run(id);
  return {
    task: getTask(id),
    changed: result.changes > 0,
  };
}

export function deleteTask(id: string): boolean {
  const result = stmtDeleteTask.run(id);
  return result.changes > 0;
}

export function getAppSetting(key: string): string | null {
  const row = stmtGetAppSetting.get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string | null): void {
  if (value === null) {
    stmtDeleteAppSetting.run(key);
    return;
  }
  stmtSetAppSetting.run(key, value);
}

export function getTaskMessages(taskId: string): TaskMessage[] {
  return stmtGetTaskMessages.all(taskId) as TaskMessage[];
}

export function appendTaskMessage(
  taskId: string,
  role: TaskMessage['role'],
  content: string,
  thinking?: string | null,
  createdAt = Date.now(),
): TaskMessage {
  const row: TaskMessage = {
    id: uuid(),
    task_id: taskId,
    role,
    content,
    thinking: thinking ?? undefined,
    created_at: createdAt,
  };
  stmtInsertTaskMessage.run({
    ...row,
    thinking: row.thinking ?? null,
  });
  return row;
}

interface ActivityContextRow {
  id: string;
  source_event_id: string | null;
  trigger: string;
  spoken_input: string | null;
  captured_text: string | null;
  active_window_json: string | null;
  images_json: string | null;
  decision_json: string | null;
  promoted_task_id: string | null;
  created_at: number;
  updated_at: number;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseActivityDecision(value: string | null): ActivityIntentDecision | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const action = parsed.action === 'create_task' ? 'create_task' : 'save_context';
  return {
    action,
    title: typeof parsed.title === 'string' ? parsed.title : '',
    taskDescription: typeof parsed.taskDescription === 'string' ? parsed.taskDescription : '',
    hasEnoughContext: parsed.hasEnoughContext === true,
    screenContextRequired: parsed.screenContextRequired === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  };
}

function activityContextFromRow(row: ActivityContextRow): ActivityContext {
  return {
    id: row.id,
    source_event_id: row.source_event_id,
    trigger: row.trigger,
    spoken_input: row.spoken_input,
    captured_text: row.captured_text,
    active_window: parseJsonObject(row.active_window_json),
    images: parseJsonObject(row.images_json),
    decision: parseActivityDecision(row.decision_json),
    promoted_task_id: row.promoted_task_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function jsonString(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function getAllActivityContexts(): ActivityContext[] {
  return (stmtAllActivityContexts.all() as ActivityContextRow[]).map(activityContextFromRow);
}

export function getActivityContext(id: string): ActivityContext | undefined {
  const row = stmtGetActivityContext.get(id) as ActivityContextRow | undefined;
  return row ? activityContextFromRow(row) : undefined;
}

export function getActivityContextBySourceEventId(sourceEventId: string): ActivityContext | undefined {
  const row = stmtGetActivityContextBySourceEventId.get(sourceEventId) as ActivityContextRow | undefined;
  return row ? activityContextFromRow(row) : undefined;
}

export function insertActivityContext(context: {
  source_event_id?: string | null;
  trigger: string;
  spoken_input?: string | null;
  captured_text?: string | null;
  active_window?: unknown;
  images?: unknown;
  decision?: ActivityIntentDecision | null;
  promoted_task_id?: string | null;
}): ActivityContext {
  const id = uuid();
  const now = Date.now();
  stmtInsertActivityContext.run({
    id,
    source_event_id: context.source_event_id ?? null,
    trigger: context.trigger,
    spoken_input: context.spoken_input ?? null,
    captured_text: context.captured_text ?? null,
    active_window_json: jsonString(context.active_window),
    images_json: jsonString(context.images),
    decision_json: jsonString(context.decision),
    promoted_task_id: context.promoted_task_id ?? null,
    created_at: now,
    updated_at: now,
  });
  const result = getActivityContext(id);
  if (!result) throw new Error(`Failed to retrieve inserted activity context ${id}`);
  return result;
}

export function updateActivityContextPromotedTask(id: string, taskId: string | null): ActivityContext | undefined {
  stmtUpdateActivityContextPromotedTask.run(taskId, Date.now(), id);
  return getActivityContext(id);
}

export function updateActivityContextDetails(id: string, context: {
  trigger: string;
  spoken_input?: string | null;
  captured_text?: string | null;
  active_window?: unknown;
  images?: unknown;
  decision?: ActivityIntentDecision | null;
}): ActivityContext | undefined {
  stmtUpdateActivityContextDetails.run({
    id,
    trigger: context.trigger,
    spoken_input: context.spoken_input ?? null,
    captured_text: context.captured_text ?? null,
    active_window_json: jsonString(context.active_window),
    images_json: jsonString(context.images),
    decision_json: jsonString(context.decision),
    updated_at: Date.now(),
  });
  return getActivityContext(id);
}

export function deleteActivityContext(id: string): boolean {
  return stmtDeleteActivityContext.run(id).changes > 0;
}
