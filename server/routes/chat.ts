import { Router } from 'express';
import { contextFromTask, getTask, getTaskMessages, updateTask } from '../db/queries.js';
import { agents } from '../app.js';
import { broadcast, initSSE } from '../events.js';
import {
  getRun,
  getRunContext,
  getRunStatus,
  sendSnapshot,
  subscribe,
} from '../live-chat.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { toErrorMessage } from '../errors.js';
import { startTaskRun } from '../task-runner.js';
import type { Task } from '../../shared/types.js';
import {
  appendAttachmentContext,
  attachmentUploadMiddleware,
  cleanupUploadedAttachments,
  saveTaskAttachments,
  uploadedAttachments,
} from '../attachments.js';
import { enrichImageAttachmentContext } from '../image-context.js';
import { loadOrganizationAccess, requireTaskMutable, requireTaskVisible } from '../organization-access.js';
import { isLocalMode } from '../deployment-config.js';
import { enterpriseJson, formDataFromRequestBody, hasSelectedOrganization, organizationIdFromRequest, proxyEnterpriseJson } from '../enterprise-client.js';
import { taskFromEnterprise } from './tasks.js';

export const chatRouter = Router();

function normalizeEnterpriseMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const createdAt = typeof msg.created_at === 'string'
    ? new Date(msg.created_at).getTime()
    : typeof msg.created_at === 'number' ? msg.created_at : Date.now();
  return {
    ...msg,
    id: msg.id ?? msg.message_id ?? crypto.randomUUID(),
    created_at: createdAt,
  };
}

function dedupeConsecutiveEnterpriseUserMessages(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.filter((message, index) => {
    if (message.role !== 'user' || index === 0) return true;
    const previous = messages[index - 1];
    return previous.role !== 'user' || previous.content !== message.content;
  });
}

function hasNoSession(task: Task): boolean {
  if (task.last_agent_response_at !== null) return false;
  return getRunStatus(task.id)?.status !== 'streaming';
}

chatRouter.get('/:id/messages', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req);
    if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
    try {
      const raw = await enterpriseJson<Record<string, unknown>[]>(
        req,
        `/organization/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(req.params.id)}/messages`,
      );
      const messages = Array.isArray(raw)
        ? dedupeConsecutiveEnterpriseUserMessages(raw.map(normalizeEnterpriseMessage))
        : [];
      return res.json({ messages, context: null });
    } catch (error) {
      return res.status((error as { status?: number }).status ?? 502).json({
        error: toErrorMessage(error, 'Failed to load messages'),
      });
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
  const liveContext = getRunContext(task.id);
  const context = liveContext !== undefined ? liveContext : contextFromTask(task);
  if (hasNoSession(task)) return res.json({ messages: [], context });

  try {
    const messages = task.agent_runtime && task.agent_runtime !== 'hermes'
      ? getTaskMessages(task.id)
      : await agents.adapterFor(task.agent_runtime).getMessages(task.id, task.id);
    res.json({ messages, context });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Task session history unavailable') });
  }
});

chatRouter.get('/:id/session', async (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req);
    if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
    return proxyEnterpriseJson(req, res, `/organization/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(req.params.id)}/session`);
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const task = requireTaskVisible(getTask(req.params.id), organizationContext);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (hasNoSession(task)) return res.json({ session: null });

  try {
    const session = await agents.adapterFor(task.agent_runtime).getSessionMetadata(task.id);
    res.json({ session });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Task session metadata unavailable') });
  }
});

chatRouter.post('/:id/messages', attachmentUploadMiddleware, async (req, res) => {
  const taskId = String(req.params.id);

  if (isLocalMode() && hasSelectedOrganization(req)) {
    const orgId = organizationIdFromRequest(req);
    if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const files = uploadedAttachments(req);
    try {
      const raw = await enterpriseJson<Record<string, unknown>>(
        req,
        `/organization/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(taskId)}`,
      );
      const localTask = taskFromEnterprise(raw);
      if (localTask.status === 'pending' || localTask.status === 'assigned') {
        return res.status(409).json({ error: 'Move this task to In Progress before sending messages' });
      }
      let runContent = content;
      if (files.length > 0) {
        const body = await formDataFromRequestBody({ content, role: 'user' }, files);
        const message = await enterpriseJson<Record<string, unknown>>(
          req,
          `/organization/${encodeURIComponent(orgId)}/tasks/${encodeURIComponent(taskId)}/messages`,
          { method: 'POST', body },
        );
        if (typeof message.content === 'string' && message.content.trim()) runContent = message.content;
      }
      const { startEnterpriseTaskRun } = await import('../enterprise-runner.js');
      const run = await startEnterpriseTaskRun(req, localTask, runContent, { persistUserMessage: files.length === 0 });
      if (!run?.runId) throw new Error('Enterprise run returned invalid result');
      return res.status(202).json({ runId: run.runId, run });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) return res.status(409).json({ error: toErrorMessage(error, 'Task already has a message in progress') });
      return res.status(status ?? 502).json({ error: toErrorMessage(error, 'Failed to start enterprise task run') });
    } finally {
      await cleanupUploadedAttachments(files);
    }
  }

  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
  }

  const task = requireTaskMutable(getTask(taskId), organizationContext);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'pending' || task.status === 'assigned') {
    return res.status(409).json({ error: 'Move this task to In Progress before sending messages' });
  }

  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  try {
    runSettings = parseRunSettingsBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid run settings') });
  }

  let runTask = task;
  if (runSettings.hasFields) {
    const { taskFields } = runSettings;
    const changed =
      (taskFields.agent_runtime !== undefined && taskFields.agent_runtime !== task.agent_runtime) ||
      (taskFields.agent_model !== undefined && taskFields.agent_model !== task.agent_model) ||
      (taskFields.reasoning_effort !== undefined && taskFields.reasoning_effort !== task.reasoning_effort);
    if (changed) {
      const updated = updateTask(task.id, taskFields);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      runTask = updated;
      broadcast({ type: 'task_updated', task: updated });
    }
  }

  try {
    const files = uploadedAttachments(req);
    let messageContent = content;
    try {
      const attachments = await enrichImageAttachmentContext(await saveTaskAttachments(runTask.id, files));
      messageContent = appendAttachmentContext(content, attachments);
    } finally {
      await cleanupUploadedAttachments(files);
    }

    const run = startTaskRun(runTask, messageContent);
    res.status(202).json({ runId: run.runId, run });
  } catch (error) {
    const isConflict = error instanceof Error && error.message.includes('already has a message in progress');
    res.status(isConflict ? 409 : 500).json({ error: toErrorMessage(error, 'Failed to start task run') });
  }
});

chatRouter.get('/:id/live', (req, res) => {
  if (isLocalMode() && hasSelectedOrganization(req)) {
    // Agent runs always execute locally even in local+org mode.
    // The enterprise server has no /live SSE endpoint, so always serve locally.
    const run = getRun(req.params.id);
    initSSE(res);
    subscribe(req.params.id, res);
    if (run) sendSnapshot(res, run);
    return;
  }

  loadOrganizationAccess(req)
    .then((organizationContext) => {
      const task = requireTaskVisible(getTask(req.params.id), organizationContext);

      initSSE(res);

      if (!task) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Task not found' })}\n\n`);
        res.end();
        return;
      }

      subscribe(task.id, res);

      const run = getRun(task.id);
      if (run) sendSnapshot(res, run);
    })
    .catch((error) => {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: toErrorMessage(error, 'Organization access denied') })}\n\n`);
        res.end();
      } else {
        res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
      }
    });
});
