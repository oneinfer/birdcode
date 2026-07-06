import { insertTask, updateTask } from './db/queries.js';
import {
  buildTaskExecutionRequest,
  buildTaskPlanningRequest,
  buildTaskPlanningSystemPrompt,
} from './prompts/task-agent.js';
import { startTaskRun } from './task-runner.js';
import type { AgentRuntime, ReasoningEffort, Task, TaskKind, TaskMode } from '../shared/types.js';

const LOW_INFORMATION_TITLES = new Set(['?', 'hi', 'hello', 'hey', 'yo']);

export function generateTaskTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  const normalizedFirstLine = firstLine.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!normalizedFirstLine || LOW_INFORMATION_TITLES.has(normalizedFirstLine)) return 'Untitled task';

  const firstSentence = firstLine.split(/[.!?]/)[0].trim();
  if (!firstSentence) return text.slice(0, 60).trim() || 'Untitled task';
  if (firstSentence.length <= 60) return firstSentence;
  return `${firstSentence.slice(0, 57)}...`;
}

export function startTaskImmediately(task: Task): Task {
  const started = updateTask(task.id, { status: 'in_progress' }) ?? task;

  if (started.task_mode === 'plan') {
    startTaskRun(
      started,
      buildTaskPlanningRequest({ title: started.title, description: started.description }),
      {
        systemMessage: buildTaskPlanningSystemPrompt({
          title: started.title,
          description: started.description,
          workspacePath: started.workspace_path,
        }),
      },
    );
    return started;
  }

  startTaskRun(started, started.description ?? started.title);
  return started;
}

export function activationPromptForTask(task: Task): string {
  return task.task_mode === 'plan' && task.last_agent_response_at !== null
    ? buildTaskExecutionRequest({ title: task.title, description: task.description })
    : (task.description ?? task.title);
}

export function startTaskPlanningRun(task: Task): void {
  startTaskRun(
    task,
    buildTaskPlanningRequest({ title: task.title, description: task.description }),
    {
      systemMessage: buildTaskPlanningSystemPrompt({
        title: task.title,
        description: task.description,
        workspacePath: task.workspace_path,
      }),
    },
  );
}

export function startTaskActivationRun(task: Task): void {
  startTaskRun(task, activationPromptForTask(task));
}

export function inactiveStatusForTaskScope(task: Pick<Task, 'organization_id'>): Task['status'] {
  return task.organization_id ? 'assigned' : 'pending';
}

export function createTaskRecord(input: {
  description: string;
  title?: string | null;
  status?: Task['status'];
  taskKind?: TaskKind;
  taskMode?: TaskMode;
  workspacePath?: string | null;
  organizationId?: string | null;
  creatorDeveloperId?: string | null;
  creatorEmail?: string | null;
  creatorFirstName?: string | null;
  creatorLastName?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  assigneeDeveloperId?: string | null;
  assigneeEmail?: string | null;
  assigneeFirstName?: string | null;
  assigneeLastName?: string | null;
  runtime?: AgentRuntime | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}): Task {
  const title = input.title?.trim() || generateTaskTitle(input.description);
  const requestedStatus = input.status ?? 'pending';
  const status = requestedStatus === 'pending' && input.organizationId
    ? 'assigned'
    : requestedStatus;
  return insertTask({
    title,
    description: input.description,
    status,
    task_kind: input.taskKind ?? 'task',
    task_mode: input.taskMode ?? 'direct',
    workspace_path: input.workspacePath ?? null,
    organization_id: input.organizationId ?? null,
    creator_developer_id: input.creatorDeveloperId ?? null,
    creator_email: input.creatorEmail ?? null,
    creator_first_name: input.creatorFirstName ?? null,
    creator_last_name: input.creatorLastName ?? null,
    team_id: input.teamId ?? null,
    team_name: input.teamName ?? null,
    assignee_developer_id: input.assigneeDeveloperId ?? null,
    assignee_email: input.assigneeEmail ?? null,
    assignee_first_name: input.assigneeFirstName ?? null,
    assignee_last_name: input.assigneeLastName ?? null,
    agent_runtime: input.runtime ?? null,
    agent_model: input.model ?? null,
    reasoning_effort: input.reasoningEffort ?? null,
  });
}
