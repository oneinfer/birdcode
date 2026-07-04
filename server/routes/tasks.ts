import { Router, type Request, type Response } from 'express';
import { deleteTask, getRecentTaskByDescription, getTask, getVisibleTasks, markTaskViewed, saveProject, setAppSetting, updateTask } from '../db/queries.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { broadcast } from '../events.js';
import { toErrorMessage } from '../errors.js';
import { defaultRuntime, parseRuntimeValue, runtimeLabel, runtimeSupportsGoals } from '../runtime-config.js';
import { parseWorkspacePath } from '../workspace-access.js';
import { CURRENT_PROJECT_SETTING_KEY } from './projects.js';
import { TASK_KINDS, TASK_MODES, TASK_STATUSES } from '../../shared/types.js';
import type { TaskKind, TaskMode, TaskStatus } from '../../shared/types.js';
import { createTaskRecord, generateTaskTitle, startTaskActivationRun, activationPromptForTask, startTaskImmediately } from '../task-service.js';
import {
  loadOrganizationAccess,
  parseAssignmentInput,
  requireTaskManageable,
  requireTaskMutable,
  requireTaskStartable,
  requireTaskVisible,
  resolveTaskAssignment,
  visibilityParamsFromContext,
} from '../organization-access.js';
import { isLocalMode } from '../deployment-config.js';
import {
  appendAttachmentContext,
  attachmentUploadMiddleware,
  cleanupUploadedAttachments,
  deleteTaskAttachments,
  saveTaskAttachments,
  uploadedAttachments,
} from '../attachments.js';
import { enrichImageAttachmentContext } from '../image-context.js';
import { notifyTaskCreated } from '../native-notifications.js';
import { enterpriseJson, formDataFromRequestBody, hasSelectedOrganization, organizationIdFromRequest, proxyEnterpriseResponse } from '../enterprise-client.js';
import type { Task, AgentRuntime, ReasoningEffort } from '../../shared/types.js';

function isoToMs(v: unknown): number | null {
  if (!v || typeof v !== 'string') return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function optionalString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function taskFromEnterprise(r: Record<string, unknown>): Task {
  return {
    id: String(r.task_id ?? r.id ?? ''),
    title: String(r.title ?? ''),
    description: r.description != null ? String(r.description) : null,
    status: (r.status as Task['status']) ?? 'pending',
    task_kind: (r.task_kind as Task['task_kind']) ?? 'task',
    task_mode: (r.task_mode as Task['task_mode']) ?? 'direct',
    workspace_path: r.workspace_path != null ? String(r.workspace_path) : null,
    organization_id: r.organization_id != null ? String(r.organization_id) : null,
    creator_developer_id: r.creator_developer_id != null ? String(r.creator_developer_id) : null,
    creator_email: optionalString(r.created_by_email, r.creator_email),
    creator_first_name: optionalString(r.created_by_first_name, r.creator_first_name),
    creator_last_name: optionalString(r.created_by_last_name, r.creator_last_name),
    team_id: r.team_id != null ? String(r.team_id) : null,
    team_name: r.team_name != null ? String(r.team_name) : null,
    assignee_developer_id: r.assignee_developer_id != null ? String(r.assignee_developer_id) : null,
    assignee_email: optionalString(r.assigned_to_email, r.assignee_email),
    assignee_first_name: optionalString(r.assigned_to_first_name, r.assignee_first_name),
    assignee_last_name: optionalString(r.assigned_to_last_name, r.assignee_last_name),
    agent_runtime: r.agent_runtime != null ? (r.agent_runtime as AgentRuntime) : null,
    agent_model: r.agent_model != null ? String(r.agent_model) : null,
    reasoning_effort: r.reasoning_effort != null ? (r.reasoning_effort as ReasoningEffort) : null,
    created_at: isoToMs(r.created_at) ?? Date.now(),
    updated_at: isoToMs(r.updated_at) ?? Date.now(),
    last_agent_response_at: isoToMs(r.last_agent_response_at),
    last_viewed_at: isoToMs(r.last_viewed_at),
    last_context_used_tokens: typeof r.last_context_used_tokens === 'number' ? r.last_context_used_tokens : null,
    last_context_window_tokens: typeof r.last_context_window_tokens === 'number' ? r.last_context_window_tokens : null,
  };
}

export const tasksRouter = Router();

const RECENT_TASK_DEDUPE_MS = 10_000;
const LOCAL_ONLY_TASK_FIELDS = new Set(['workspacePath', 'workspace_path', 'repoPath', 'repo_path']);
const TASK_START_FIELDS = new Set(['start', 'startImmediately', 'run']);

tasksRouter.get('/', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    try {
      const tasks = await enterpriseJson<Record<string, unknown>[]>(req, `/organization/${orgId}/tasks${query}`);
      return res.json({ tasks: (tasks ?? []).map(taskFromEnterprise) });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 502).json({ error: toErrorMessage(error, 'Failed to list tasks') });
    }
  }

  try {
    const organizationContext = await loadOrganizationAccess(req);
    const status = req.query.status as TaskStatus | undefined;
    const tasks = getVisibleTasks(visibilityParamsFromContext(organizationContext), status);
    res.json({ tasks });
  } catch (error) {
    res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }
});

tasksRouter.get('/:id', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    try {
      const task = await enterpriseJson<Record<string, unknown>>(req, `/organization/${orgId}/tasks/${encodeURIComponent(req.params.id)}`);
      return res.json({ task: taskFromEnterprise(task) });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 404).json({ error: 'Task not found' });
    }
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const task = requireTaskVisible(getTask(req.params.id), organizationContext);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

async function proxyTaskAttachment(req: Request, res: Response, action: 'view' | 'download') {
  const orgId = organizationIdFromRequest(req);
  if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
  return proxyEnterpriseResponse(
    req,
    res,
    `/organization/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(String(req.params.id))}/attachments/${encodeURIComponent(String(req.params.attachmentId))}/${action}`,
  );
}

tasksRouter.get('/:id/attachments/:attachmentId/view', async (req, res) => {
  return proxyTaskAttachment(req, res, 'view');
});

tasksRouter.get('/:id/attachments/:attachmentId/download', async (req, res) => {
  return proxyTaskAttachment(req, res, 'download');
});

function parseTaskMode(value: unknown): TaskMode {
  if (value === undefined || value === null || value === '') return 'direct';
  if (typeof value !== 'string' || !(TASK_MODES as readonly string[]).includes(value)) {
    throw new Error(`taskMode must be one of: ${TASK_MODES.join(', ')}`);
  }
  return value as TaskMode;
}

function parseTaskKind(value: unknown): TaskKind {
  if (value === undefined || value === null || value === '') return 'task';
  if (typeof value !== 'string' || !(TASK_KINDS as readonly string[]).includes(value)) {
    throw new Error(`taskKind must be one of: ${TASK_KINDS.join(', ')}`);
  }
  return value as TaskKind;
}

function parseBooleanFlag(value: unknown, fieldName: string): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a boolean`);
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${fieldName} must be a boolean`);
}

function hasStartTimeField(body: Record<string, unknown>): boolean {
  return [
    'start',
    'startImmediately',
    'run',
    'workspacePath',
    'workspace_path',
    'repoPath',
    'repo_path',
    'runtime',
    'agentRuntime',
    'agent_runtime',
    'model',
    'agentModel',
    'agent_model',
    'reasoningEffort',
    'reasoning_effort',
    'taskMode',
    'task_mode',
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

const ENTERPRISE_CREATE_FIELD_MAP: Record<string, string | null> = {
  taskKind: 'task_kind',
  taskMode: 'task_mode',
  teamId: 'team_id',
  assigneeDeveloperId: null,
  assigneeEmail: 'assigned_to_email',
};

function enterpriseCreateField(key: string, value: unknown): [string, unknown] | null {
  if (LOCAL_ONLY_TASK_FIELDS.has(key)) return null;
  if (TASK_START_FIELDS.has(key)) return null;
  if (key in ENTERPRISE_CREATE_FIELD_MAP) {
    const mapped = ENTERPRISE_CREATE_FIELD_MAP[key];
    return mapped ? [mapped, value] : null;
  }
  return [key, value];
}

async function enterpriseCreateBody(
  reqBody: Record<string, unknown>,
  files: Express.Multer.File[],
): Promise<FormData> {
  return formDataFromRequestBody(reqBody, files, (key, value) => {
    const transformed = enterpriseCreateField(key, value);
    if (!transformed) return null;
    const [nextKey, nextValue] = transformed;
    return [nextKey, nextValue];
  });
}

function startMessageFromBody(body: Record<string, unknown>): string {
  const value = body.message ?? body.additionalContext ?? body.additional_context;
  return typeof value === 'string' ? value.trim() : '';
}

function appendStartContext(description: string | null, title: string, message: string): string {
  const base = (description?.trim() || title.trim()).trim();
  if (!message) return base;
  return `${base}

Additional context provided before starting:
${message}`;
}

tasksRouter.post('/', attachmentUploadMiddleware, async (req, res) => {
  const files = uploadedAttachments(req);
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: 'description is required' });
  }

  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    try {
      const resolvedTitle = (title && typeof title === 'string' && title.trim())
        ? title.trim()
        : generateTaskTitle(description);
      const body = await enterpriseCreateBody(
        { ...(req.body as Record<string, unknown>), title: resolvedTitle },
        files,
      );
      const created = await enterpriseJson<Record<string, unknown>>(req, `/organization/${orgId}/tasks`, {
        method: 'POST',
        body,
      });
      return res.status(201).json({ task: taskFromEnterprise(created) });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 502).json({
        error: toErrorMessage(error, 'Failed to create organization task on enterprise OpenBees'),
      });
    } finally {
      await cleanupUploadedAttachments(files);
    }
  }

  const shouldStart = parseBooleanFlag(
    (req.body as Record<string, unknown>).start
      ?? (req.body as Record<string, unknown>).startImmediately
      ?? (req.body as Record<string, unknown>).run,
    'start',
  );

  if (!shouldStart && hasStartTimeField(req.body as Record<string, unknown>)) {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({
      error: 'Task creation only accepts task details and assignment. Choose repo and AI settings when starting the task.',
      code: 'start_settings_not_allowed',
    });
  }

  let taskKind: TaskKind;
  let organizationContext: Awaited<ReturnType<typeof loadOrganizationAccess>>;
  let taskAssignment: ReturnType<typeof resolveTaskAssignment>;
  try {
    const assignmentInput = parseAssignmentInput(req, false);
    organizationContext = await loadOrganizationAccess(req, assignmentInput.organizationId || null);
    taskAssignment = resolveTaskAssignment(organizationContext, assignmentInput);
    taskKind = parseTaskKind(req.body.taskKind ?? req.body.task_kind);
  } catch (error) {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  const recentDuplicate = files.length === 0
    ? getRecentTaskByDescription(description, Date.now() - RECENT_TASK_DEDUPE_MS)
    : undefined;
  if (recentDuplicate && requireTaskVisible(recentDuplicate, organizationContext)) {
    return res.status(200).json({ task: recentDuplicate, duplicate: true });
  }

  const resolvedTitle = title && typeof title === 'string' && title.trim()
    ? title.trim()
    : generateTaskTitle(description);
  let task = createTaskRecord({
    title: resolvedTitle,
    description,
    status: taskAssignment.organization_id ? 'assigned' : 'pending',
    taskKind,
    organizationId: taskAssignment.organization_id,
    creatorDeveloperId: taskAssignment.creator_developer_id,
    creatorEmail: taskAssignment.creator_email,
    creatorFirstName: taskAssignment.creator_first_name,
    creatorLastName: taskAssignment.creator_last_name,
    teamId: taskAssignment.team_id,
    teamName: taskAssignment.team_name,
    assigneeDeveloperId: taskAssignment.assignee_developer_id,
    assigneeEmail: taskAssignment.assignee_email,
    assigneeFirstName: taskAssignment.assignee_first_name,
    assigneeLastName: taskAssignment.assignee_last_name,
  });

  try {
    const attachments = await enrichImageAttachmentContext(await saveTaskAttachments(task.id, files));
    if (attachments.length > 0) {
      task = updateTask(task.id, {
        description: appendAttachmentContext(description, attachments),
      }) ?? task;
    }
  } catch (error) {
    deleteTask(task.id);
    await deleteTaskAttachments(task.id).catch(() => undefined);
    return res.status(400).json({ error: toErrorMessage(error, 'Failed to save attachments') });
  } finally {
    await cleanupUploadedAttachments(files);
  }

  notifyTaskCreated(task);
  broadcast({ type: 'task_created', task });

  if (shouldStart) {
    try {
      const started = startTaskImmediately(task);
      return res.status(201).json({ task: started });
    } catch {
      // start failed but task was created — return task as-is
    }
  }

  res.status(201).json({ task });
});

tasksRouter.post('/:id/start', attachmentUploadMiddleware, async (req, res) => {
  const taskId = String(req.params.id);
  const files = uploadedAttachments(req);
  // Parse start settings first (needed for both enterprise and local paths)
  let workspacePath: string | null | undefined;
  let runtime: ReturnType<typeof parseRuntimeValue>;
  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  let taskMode: TaskMode;
  const startMessage = startMessageFromBody(req.body as Record<string, unknown>);
  try {
    workspacePath = parseWorkspacePath(req.body);
    if (!workspacePath) throw new Error('workspacePath is required');
    runtime = parseRuntimeValue(req.body.runtime);
    runSettings = parseRunSettingsBody(req.body);
    taskMode = parseTaskMode(req.body.taskMode ?? req.body.task_mode);
  } catch (error) {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid start settings' });
  }

  const resolvedRuntime = runtime ?? runSettings.taskFields.agent_runtime ?? defaultRuntime();
  if (taskMode === 'plan' && !runtimeSupportsGoals(resolvedRuntime)) {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: `Goal feature is not available for ${runtimeLabel(resolvedRuntime)}.` });
  }

  // Enterprise path: task lives on the enterprise server, not in local SQLite
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    let enterpriseTask: Record<string, unknown>;
    try {
      enterpriseTask = await enterpriseJson<Record<string, unknown>>(
        req, `/organization/${orgId}/tasks/${encodeURIComponent(taskId)}`
      );
    } catch (error) {
      await cleanupUploadedAttachments(files);
      return res.status((error as { status?: number }).status ?? 404).json({ error: 'Task not found' });
    }

    let current = taskFromEnterprise(enterpriseTask);
    if (current.status !== 'pending' && current.status !== 'assigned') {
      await cleanupUploadedAttachments(files);
      return res.status(409).json({ error: 'Only pending or assigned tasks can be started', code: 'task_not_inactive' });
    }

    // Start enterprise task and persist shared start-context attachments there.
    try {
      const body = await formDataFromRequestBody({
        workspace_path: workspacePath,
        agent_runtime: resolvedRuntime,
        agent_model: runSettings.taskFields.agent_model ?? null,
        reasoning_effort: runSettings.taskFields.reasoning_effort ?? null,
        task_mode: taskMode,
        message: startMessage,
      }, files);
      const started = await enterpriseJson<Record<string, unknown>>(
        req,
        `/organization/${orgId}/tasks/${encodeURIComponent(taskId)}/start`,
        { method: 'POST', body },
      );
      current = taskFromEnterprise(started);
    } catch (error) {
      await cleanupUploadedAttachments(files);
      return res.status((error as { status?: number }).status ?? 502).json({
        error: toErrorMessage(error, 'Failed to start task on enterprise OpenBees'),
      });
    } finally {
      await cleanupUploadedAttachments(files);
    }

    // Apply workspace_path locally (enterprise never stores this) and start agent
    const localTask: Task = { ...current, workspace_path: workspacePath };
    const { startEnterpriseTaskRun } = await import('../enterprise-runner.js');
    void startEnterpriseTaskRun(
      req,
      localTask,
      activationPromptForTask(localTask),
      { persistUserMessage: false },
    ).catch(() => undefined);

    const project = saveProject({
      path: workspacePath,
      organization_id: localTask.organization_id,
      creator_developer_id: localTask.creator_developer_id,
    });
    setAppSetting(CURRENT_PROJECT_SETTING_KEY, workspacePath);
    broadcast({ type: 'project_saved', project });
    return res.json({ task: localTask });
  }

  // Local path: task lives in local SQLite
  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    await cleanupUploadedAttachments(files);
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const visible = requireTaskVisible(getTask(taskId), organizationContext);
  if (!visible) {
    await cleanupUploadedAttachments(files);
    return res.status(404).json({ error: 'Task not found' });
  }
  const current = requireTaskStartable(visible, organizationContext);
  if (!current) {
    await cleanupUploadedAttachments(files);
    return res.status(403).json({ error: 'You do not have permission to start this task' });
  }
  if (current.status !== 'pending' && current.status !== 'assigned') {
    await cleanupUploadedAttachments(files);
    return res.status(409).json({ error: 'Only pending or assigned tasks can be started', code: 'task_not_inactive' });
  }

  let description = appendStartContext(current.description, current.title, startMessage);
  try {
    const attachments = await enrichImageAttachmentContext(await saveTaskAttachments(current.id, files));
    description = appendAttachmentContext(description, attachments);
  } catch (error) {
    await deleteTaskAttachments(current.id).catch(() => undefined);
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: toErrorMessage(error, 'Failed to save attachments') });
  } finally {
    await cleanupUploadedAttachments(files);
  }

  const updated = updateTask(current.id, {
    status: 'in_progress',
    description,
    task_mode: taskMode,
    workspace_path: workspacePath,
    agent_runtime: resolvedRuntime,
    agent_model: runSettings.taskFields.agent_model ?? null,
    reasoning_effort: runSettings.taskFields.reasoning_effort ?? null,
  });
  if (!updated) return res.status(404).json({ error: 'Task not found' });

  try {
    startTaskActivationRun(updated);
  } catch (error) {
    const reverted = updateTask(current.id, {
      status: current.status,
      task_mode: current.task_mode,
      workspace_path: current.workspace_path,
      agent_runtime: current.agent_runtime,
      agent_model: current.agent_model,
      reasoning_effort: current.reasoning_effort,
    }) ?? current;
    broadcast({ type: 'task_updated', task: reverted });
    return res.status(409).json({
      error: toErrorMessage(error, 'Task was configured but could not be started'),
    });
  }

  const project = saveProject({
    path: workspacePath,
    organization_id: updated.organization_id,
    creator_developer_id: updated.creator_developer_id,
  });
  setAppSetting(CURRENT_PROJECT_SETTING_KEY, workspacePath);
  broadcast({ type: 'project_saved', project });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

function hasAssignmentUpdate(body: Record<string, unknown>): boolean {
  return (
    body.teamId !== undefined ||
    body.team_id !== undefined ||
    body.assigneeDeveloperId !== undefined ||
    body.assignee_developer_id !== undefined
  );
}

tasksRouter.patch('/:id', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    const body = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>)
        .filter(([key]) => !LOCAL_ONLY_TASK_FIELDS.has(key)),
    );
    try {
      const task = await enterpriseJson<Record<string, unknown>>(req, `/organization/${orgId}/tasks/${encodeURIComponent(req.params.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return res.json({ task: taskFromEnterprise(task) });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 502).json({ error: toErrorMessage(error, 'Failed to update task') });
    }
  }

  const allowed = ['title', 'description', 'status'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const current = requireTaskVisible(getTask(req.params.id), organizationContext);
  if (!current) return res.status(404).json({ error: 'Task not found' });
  if (!requireTaskMutable(current, organizationContext)) {
    return res.status(403).json({ error: 'You do not have permission to update this task' });
  }

  try {
    const workspacePath = parseWorkspacePath(req.body);
    const runtime = parseRuntimeValue(req.body.runtime);
    const sensitiveUpdate = workspacePath !== undefined || runtime !== undefined || hasAssignmentUpdate(req.body);
    if (sensitiveUpdate && !requireTaskManageable(current, organizationContext)) {
      return res.status(403).json({ error: 'You do not have permission to manage this task' });
    }
    if (workspacePath !== undefined) fields.workspace_path = workspacePath;
    if (runtime !== undefined) fields.agent_runtime = runtime;
    if (req.body.taskMode !== undefined || req.body.task_mode !== undefined) {
      const taskMode = parseTaskMode(req.body.taskMode ?? req.body.task_mode);
      const resolvedRuntime = (fields.agent_runtime as ReturnType<typeof parseRuntimeValue> | undefined) ?? current.agent_runtime ?? defaultRuntime();
      if (taskMode === 'plan' && !runtimeSupportsGoals(resolvedRuntime)) {
        return res.status(400).json({ error: `Goal feature is not available for ${runtimeLabel(resolvedRuntime)}.` });
      }
      fields.task_mode = taskMode;
    }
    if (hasAssignmentUpdate(req.body)) {
      if (!current.organization_id) throw new Error('Legacy tasks cannot be assigned until they are recreated in an organization');
      const assignmentInput = parseAssignmentInput(req, false);
      assignmentInput.organizationId = current.organization_id;
      const refreshedContext = organizationContext.organizationId === current.organization_id
        ? organizationContext
        : await loadOrganizationAccess(req, current.organization_id);
      const taskAssignment = resolveTaskAssignment(refreshedContext, assignmentInput);
      fields.team_id = taskAssignment.team_id;
      fields.team_name = taskAssignment.team_name;
      fields.assignee_developer_id = taskAssignment.assignee_developer_id;
      fields.assignee_email = taskAssignment.assignee_email;
      fields.assignee_first_name = taskAssignment.assignee_first_name;
      fields.assignee_last_name = taskAssignment.assignee_last_name;
    }
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    try {
      const task = await enterpriseJson<Record<string, unknown>>(req, `/organization/${orgId}/tasks/${encodeURIComponent(req.params.id)}`);
      return res.json({ task: taskFromEnterprise(task) });
    } catch (error) {
      return res.status(404).json({ error: 'Task not found' });
    }
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  if (!requireTaskVisible(getTask(req.params.id), organizationContext)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { task, changed } = markTaskViewed(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    try {
      await enterpriseJson<unknown>(req, `/organization/${orgId}/tasks/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
      return res.json({ ok: true });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 404).json({ error: 'Task not found' });
    }
  }

  const taskId = req.params.id;
  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const task = requireTaskVisible(getTask(taskId), organizationContext);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!requireTaskManageable(task, organizationContext)) {
    return res.status(403).json({ error: 'You do not have permission to delete this task' });
  }

  const deleted = deleteTask(taskId);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  await deleteTaskAttachments(taskId).catch((error) => {
    console.warn(`Failed to delete attachments for task ${taskId}:`, error);
  });
  broadcast({ type: 'task_deleted', taskId, task });
  res.json({ ok: true });
});

tasksRouter.post('/:id/move', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req)!;
    const { status } = req.body as { status?: string };
    try {
      const updated = await enterpriseJson<Record<string, unknown>>(
        req,
        `/organization/${orgId}/tasks/${encodeURIComponent(req.params.id)}`,
        { method: 'PATCH', body: JSON.stringify({ status }) },
      );
      const task = taskFromEnterprise(updated);
      if (status === 'in_progress') {
        const { startEnterpriseTaskRun } = await import('../enterprise-runner.js');
        void startEnterpriseTaskRun(
          req,
          task,
          activationPromptForTask(task),
          { persistUserMessage: false },
        ).catch(() => undefined);
      }
      return res.json({ task });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 502).json({
        error: toErrorMessage(error, 'Failed to move task on enterprise OpenBees'),
      });
    }
  }

  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const current = requireTaskVisible(getTask(req.params.id), organizationContext);
  if (!current) return res.status(404).json({ error: 'Task not found' });
  if (!requireTaskMutable(current, organizationContext)) {
    return res.status(403).json({ error: 'You do not have permission to move this task' });
  }

  const isActivation = (current.status === 'pending' || current.status === 'assigned') && status === 'in_progress';

  if (isActivation && current.organization_id) {
    return res.status(409).json({
      error: 'Use /start to configure this task before execution',
      code: 'start_required',
    });
  }

  const updated = updateTask(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });

  if (status === 'in_progress' && !current.organization_id) {
    try {
      startTaskActivationRun(updated);
    } catch {
      // Non-fatal: status was updated, agent start failed silently
    }
  }

  res.json({ task: updated });
});
