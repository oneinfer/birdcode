import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { useStore, optimisticMoveTask } from '../lib/store';
import { createTask, deleteTask, moveTask, startTask, updateCurrentProject } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { isBoardTask, taskStatusesForScope } from '../lib/taskState';
import { useOrganizations } from '../auth/OrganizationContext';
import { primeTaskCreatedNotifications, announceTaskStarted } from '../lib/taskNotification';
import { readSavedStartSettings, writeSavedStartSettings } from '../lib/startTaskSettings';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StartTaskDialog } from './StartTaskDialog';
import { TaskCardOverlay } from './TaskCard';
import { useAuth } from '../auth/AuthContext';

const dropAnimation = {
  duration: 200,
  easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
};

type TaskFilter = 'all' | 'created_by_me' | 'assigned_to_me' | 'team' | 'unassigned';

export function Board() {
  const navigate = useNavigate();
  const tasks = useStore((s) => s.tasks);
  const streamingTaskIds = useStore((s) => s.streamingTaskIds);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const { developer } = useAuth();
  const { selectedOrganizationId } = useOrganizations();
  const showOrganizationFilters = Boolean(selectedOrganizationId);
  const boardStatuses = useMemo(() => taskStatusesForScope(selectedOrganizationId), [selectedOrganizationId]);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const visibleBoardTasks = useMemo(() => tasks.filter(isBoardTask), [tasks]);
  const isCurrentDeveloper = useMemo(() => {
    const developerId = developer?.developer_id;
    const developerEmail = developer?.email?.toLowerCase();
    return (id?: string | null, email?: string | null) => {
      if (developerId && id === developerId) return true;
      return Boolean(developerEmail && email?.toLowerCase() === developerEmail);
    };
  }, [developer?.developer_id, developer?.email]);
  const filterCounts = useMemo<Record<TaskFilter, number>>(() => ({
    all: visibleBoardTasks.length,
    created_by_me: visibleBoardTasks.filter((task) => isCurrentDeveloper(task.creator_developer_id, task.creator_email)).length,
    assigned_to_me: visibleBoardTasks.filter((task) => isCurrentDeveloper(task.assignee_developer_id, task.assignee_email)).length,
    team: visibleBoardTasks.filter((task) => Boolean(task.team_id)).length,
    unassigned: visibleBoardTasks.filter((task) => !task.team_id && !task.assignee_developer_id).length,
  }), [isCurrentDeveloper, visibleBoardTasks]);
  const filteredTasks = useMemo(() => {
    if (!showOrganizationFilters) return visibleBoardTasks;

    switch (taskFilter) {
      case 'created_by_me':
        return visibleBoardTasks.filter((task) => isCurrentDeveloper(task.creator_developer_id, task.creator_email));
      case 'assigned_to_me':
        return visibleBoardTasks.filter((task) => isCurrentDeveloper(task.assignee_developer_id, task.assignee_email));
      case 'team':
        return visibleBoardTasks.filter((task) => Boolean(task.team_id));
      case 'unassigned':
        return visibleBoardTasks.filter((task) => !task.team_id && !task.assignee_developer_id);
      case 'all':
      default:
        return visibleBoardTasks;
    }
  }, [isCurrentDeveloper, showOrganizationFilters, taskFilter, visibleBoardTasks]);
  const grouped = useMemo(() => {
    const buckets = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as Task[]])) as unknown as Record<TaskStatus, Task[]>;
    for (const t of filteredTasks) {
      const status = (t.status === 'assigned' && !selectedOrganizationId) ? 'pending' : t.status;
      if (status in buckets) buckets[status].push(t);
    }
    for (const s of TASK_STATUSES) buckets[s].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [filteredTasks, selectedOrganizationId]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isFlushingPending, setIsFlushingPending] = useState(false);
  const [flushPendingError, setFlushPendingError] = useState<string | null>(null);
  const [isCreatingPullRequestTask, setIsCreatingPullRequestTask] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [startQueue, setStartQueue] = useState<{
    tasks: Task[];
    index: number;
    source: 'single' | 'flush';
    navigateOnStarted?: boolean;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    if (!showOrganizationFilters && taskFilter !== 'all') setTaskFilter('all');
  }, [showOrganizationFilters, taskFilter]);

  function handleDragStart(event: DragStartEvent) {
    const task = (event.active.data.current as { task: Task } | undefined)?.task ?? null;
    setActiveTask(task);
  }

  // Personal tasks skip the StartTaskDialog for speed, but they still need a workspace
  // folder + runtime/model persisted on the task — otherwise the run executes with no
  // working directory and that info (and the resulting chat) never shows on the task page.
  function resolveStartSettings(task: Task) {
    const saved = readSavedStartSettings();
    const workspacePath = task.workspace_path
      ?? saved.workspacePath
      ?? currentProjectPath
      ?? localStorage.getItem('bees:lastWorkspacePath');
    if (!workspacePath) return null;

    return {
      workspacePath,
      runtime: task.agent_runtime ?? saved.runtime ?? null,
      model: task.agent_model ?? saved.model ?? null,
      reasoningEffort: task.reasoning_effort ?? saved.reasoningEffort ?? null,
      taskMode: task.task_mode ?? saved.taskMode ?? 'direct',
    };
  }

  async function quickStartPersonalTask(task: Task, settings: NonNullable<ReturnType<typeof resolveStartSettings>>): Promise<Task> {
    upsertTask({ ...task, status: 'in_progress', updated_at: Date.now() });
    try {
      const result = await startTask(task.id, settings);
      writeSavedStartSettings(settings);
      upsertTask(result.task);
      setCurrentProjectPath(settings.workspacePath);
      void updateCurrentProject(settings.workspacePath)
        .then((current) => {
          if (current.project) upsertProject(current.project);
        })
        .catch(() => undefined);
      announceTaskStarted();
      return result.task;
    } catch (error) {
      upsertTask(task);
      throw error;
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const targetStatus = over.id as TaskStatus;
    const task = (active.data.current as { task: Task })?.task;
    if (!task || task.status === targetStatus) return;

    if ((task.status === 'pending' || task.status === 'assigned') && targetStatus === 'in_progress') {
      if (task.organization_id) {
        setStartQueue({ tasks: [task], index: 0, source: 'single' });
        return;
      }
      const settings = resolveStartSettings(task);
      if (!settings) {
        setStartQueue({ tasks: [task], index: 0, source: 'single' });
        return;
      }
      try {
        await quickStartPersonalTask(task, settings);
        navigate(`/tasks/${task.id}`);
      } catch {
        // Start failed; task state was already reverted.
      }
      return;
    }

    await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
  }

  function handleRequestStart(task: Task) {
    if (task.organization_id) {
      setStartQueue({ tasks: [task], index: 0, source: 'single' });
      return;
    }
    const settings = resolveStartSettings(task);
    if (!settings) {
      setStartQueue({ tasks: [task], index: 0, source: 'single' });
      return;
    }
    void quickStartPersonalTask(task, settings)
      .then(() => navigate(`/tasks/${task.id}`))
      .catch(() => undefined);
  }

  function closeStartQueue() {
    setStartQueue(null);
    setIsFlushingPending(false);
  }

  function advanceStartQueue() {
    setStartQueue((current) => {
      if (!current) return null;
      const nextIndex = current.index + 1;
      if (nextIndex >= current.tasks.length) {
        setIsFlushingPending(false);
        return null;
      }
      return { ...current, index: nextIndex };
    });
  }

  function handleStartedTask(task: Task) {
    upsertTask(task);
    const navigateToStarted = startQueue?.navigateOnStarted;
    advanceStartQueue();
    if (navigateToStarted) navigate(`/tasks/${task.id}`);
  }

  function handleFlushPending() {
    if (isFlushingPending) return;

    const targets = grouped.pending;
    if (targets.length === 0) return;

    setIsFlushingPending(true);
    setFlushPendingError(null);

    const needsDialog: Task[] = [];

    for (const task of targets) {
      if (task.organization_id) {
        needsDialog.push(task);
        continue;
      }
      const settings = resolveStartSettings(task);
      if (!settings) {
        needsDialog.push(task);
        continue;
      }
      void quickStartPersonalTask(task, settings).catch((error) => {
        setFlushPendingError(toErrorMessage(error, 'Failed to start task'));
      });
    }

    if (needsDialog.length > 0) {
      setStartQueue({ tasks: needsDialog, index: 0, source: 'flush' });
    } else {
      setIsFlushingPending(false);
    }
  }

  async function handleCreatePullRequestWithAi() {
    if (isCreatingPullRequestTask) return;

    const targets = grouped.in_review;
    if (targets.length === 0) return;

    const workspacePaths = Array.from(
      new Set(targets.map((task) => task.workspace_path).filter((path): path is string => Boolean(path))),
    );
    const taskList = targets
      .map((task) => {
        const details = [
          `id: ${task.id}`,
          task.workspace_path ? `workspace: ${task.workspace_path}` : null,
          task.description ? `notes: ${task.description}` : null,
        ].filter(Boolean).join('; ');
        return `- ${task.title}${details ? ` (${details})` : ''}`;
      })
      .join('\n');

    const description = [
      'Create a pull request for the work represented by the Ready for review tasks below.',
      '',
      'Inspect the repository state, review the relevant changes, run the appropriate verification, create a clear commit if needed, push the branch, and open a pull request with a concise title and description. Report the PR link and any verification results when finished.',
      workspacePaths.length > 1
        ? `Multiple workspaces are represented: ${workspacePaths.join(', ')}. Choose the correct repository for the pull request and explain the choice.`
        : null,
      '',
      'Ready for review tasks:',
      taskList,
    ].filter((line): line is string => line !== null).join('\n');

    setIsCreatingPullRequestTask(true);
    setPullRequestError(null);
    primeTaskCreatedNotifications();
    try {
      const created = await createTask(
        description,
        'Create pull request',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'task',
      );
      upsertTask(created.task);
      setStartQueue({ tasks: [created.task], index: 0, source: 'single', navigateOnStarted: true });
    } catch (error) {
      setPullRequestError(toErrorMessage(error, 'Failed to create pull request task'));
    } finally {
      setIsCreatingPullRequestTask(false);
    }
  }

  function handleRequestDeleteAll(status: TaskStatus) {
    setBulkDeleteError(null);
    setDeleteAllStatus(status);
  }

  function handleCancelDeleteAll() {
    if (isBulkDeleting) return;
    setDeleteAllStatus(null);
    setBulkDeleteError(null);
  }

  async function handleConfirmDeleteAll() {
    if (!deleteAllStatus || isBulkDeleting) return;

    const targets = grouped[deleteAllStatus];
    if (targets.length === 0) {
      handleCancelDeleteAll();
      return;
    }

    setIsBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const results = await Promise.allSettled(targets.map((task) => deleteTask(task.id)));
      let failed = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          removeTask(targets[index].id);
        } else {
          failed += 1;
        }
      });

      if (failed === 0) {
        setDeleteAllStatus(null);
      } else {
        setBulkDeleteError(`Failed to delete ${failed} task${failed === 1 ? '' : 's'}.`);
      }
    } finally {
      setIsBulkDeleting(false);
    }
  }

  const deleteAllTasks = deleteAllStatus ? grouped[deleteAllStatus] : [];
  const deleteAllLabel = deleteAllStatus ? STATUS_META[deleteAllStatus].label : '';
  const deleteAllCount = deleteAllTasks.length;
  const deleteAllTaskWord = deleteAllCount === 1 ? 'task' : 'tasks';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {showOrganizationFilters && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
            {([
              ['all', 'All'],
              ['created_by_me', 'Created by me'],
              ['assigned_to_me', 'Assigned to me'],
              ['team', 'Team'],
              ['unassigned', 'Unassigned'],
            ] as const).map(([filter, label]) => {
              const selected = taskFilter === filter;
              return (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setTaskFilter(filter)}
                  className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium transition ${
                    selected
                      ? 'bg-white text-zinc-950 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 dark:ring-zinc-700'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                  }`}
                >
                  <span>{label}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                    selected
                      ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-300 dark:text-zinc-700'
                      : 'bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}>
                    {filterCounts[filter]}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="flex min-h-0 flex-1 gap-6 overflow-x-auto p-6">
          {boardStatuses.map((status, index) => (
            <Column
              key={status}
              status={status}
              tasks={grouped[status]}
              streamingTaskIds={streamingTaskIds}
              isLast={index === boardStatuses.length - 1}
              onRequestDeleteAll={handleRequestDeleteAll}
              onFlushPending={handleFlushPending}
              isFlushingPending={isFlushingPending}
              onCreatePullRequestWithAi={handleCreatePullRequestWithAi}
              isCreatingPullRequestTask={isCreatingPullRequestTask}
              onRequestStart={handleRequestStart}
            />
          ))}
        </div>
      </div>
      {flushPendingError && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-lg dark:border-red-900/70 dark:bg-red-950 dark:text-red-300">
          {flushPendingError}
        </div>
      )}
      {pullRequestError && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-lg dark:border-red-900/70 dark:bg-red-950 dark:text-red-300">
          {pullRequestError}
        </div>
      )}
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask && (
          <TaskCardOverlay
            task={activeTask}
            isStreaming={streamingTaskIds.has(activeTask.id)}
          />
        )}
      </DragOverlay>
      {deleteAllStatus && (
        <DeleteConfirmModal
          title={`Delete ${deleteAllCount} ${deleteAllLabel} ${deleteAllTaskWord}?`}
          body={
            deleteAllCount === 1
              ? `This removes the task in ${deleteAllLabel} from Bees. The Hermes session history remains in Hermes.`
              : `This removes every task in ${deleteAllLabel} from Bees. Hermes session histories remain in Hermes.`
          }
          confirmLabel={deleteAllCount === 1 ? 'Delete task' : `Delete ${deleteAllCount} tasks`}
          isConfirming={isBulkDeleting}
          error={bulkDeleteError}
          onConfirm={handleConfirmDeleteAll}
          onCancel={handleCancelDeleteAll}
        />
      )}
      {startQueue && startQueue.tasks[startQueue.index] && (
        <StartTaskDialog
          key={startQueue.tasks[startQueue.index].id}
          task={startQueue.tasks[startQueue.index]}
          title={startQueue.source === 'flush' ? 'Flush pending task' : 'Start task'}
          queueLabel={startQueue.source === 'flush' ? `${startQueue.index + 1} of ${startQueue.tasks.length}` : undefined}
          onStarted={handleStartedTask}
          onSkip={startQueue.source === 'flush' ? advanceStartQueue : undefined}
          onClose={closeStartQueue}
        />
      )}
    </DndContext>
  );
}
