import { useCallback, useMemo, useState } from 'react';
import { FolderOpen, GitBranch, Loader2, Play, X } from 'lucide-react';
import type { Task, TaskMode } from '@shared/types';
import { InputToolbar } from './InputToolbar';
import { pickWorkspaceDirectory, startTask, updateCurrentProject } from '../lib/api';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { useStore } from '../lib/store';
import { toErrorMessage } from '../lib/format';
import { readSavedStartSettings, writeSavedStartSettings } from '../lib/startTaskSettings';

interface StartTaskDialogProps {
  task: Task;
  title?: string;
  queueLabel?: string;
  onStarted: (task: Task) => void;
  onClose: () => void;
  onSkip?: () => void;
}

export function StartTaskDialog({
  task,
  title = 'Start task',
  queueLabel,
  onStarted,
  onClose,
  onSkip,
}: StartTaskDialogProps) {
  const saved = useMemo(readSavedStartSettings, []);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const [workspacePath, setWorkspacePath] = useState(
    task.workspace_path ?? saved.workspacePath ?? currentProjectPath ?? localStorage.getItem('bees:lastWorkspacePath') ?? '',
  );
  const [taskMode, setTaskMode] = useState<TaskMode>(task.task_mode ?? saved.taskMode ?? 'direct');
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    defaults,
    runtimeOptions,
    runtime,
    setRuntime,
    modelGroups,
    runtimeDefaultModel,
    model,
    setModel,
    reasoningEffort,
    setReasoningEffort,
    isLoading,
  } = useAgentConfig(task.id, {
    runtime: task.agent_runtime ?? saved.runtime ?? null,
    model: task.agent_model ?? saved.model ?? null,
    reasoningEffort: task.reasoning_effort ?? saved.reasoningEffort ?? null,
  });

  const normalizedWorkspacePath = workspacePath.trim();
  const effectiveRuntime = runtime ?? defaults?.runtime ?? 'hermes';
  const runtimeMeta = runtimeOptions.find((option) => option.id === effectiveRuntime);
  const runtimeNeedsSetup = runtimeMeta?.status === 'configure';
  const planUnsupported = taskMode === 'plan' && runtimeMeta?.supportsGoals === false;
  const configPending = isLoading && !defaults;
  const startDisabled = (
    !normalizedWorkspacePath ||
    isStarting ||
    configPending ||
    runtimeNeedsSetup ||
    planUnsupported
  );

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isStarting) return;
    setIsPickingWorkspace(true);
    setError(null);
    try {
      const result = await pickWorkspaceDirectory(normalizedWorkspacePath || null);
      if (result.path) setWorkspacePath(result.path);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to choose project folder'));
    } finally {
      setIsPickingWorkspace(false);
    }
  }, [isPickingWorkspace, isStarting, normalizedWorkspacePath]);

  const handleStart = useCallback(async () => {
    if (startDisabled) return;
    setIsStarting(true);
    setError(null);
    try {
      const settings = {
        workspacePath: normalizedWorkspacePath,
        runtime: effectiveRuntime,
        model,
        reasoningEffort,
        taskMode,
      };
      const result = await startTask(task.id, settings);
      writeSavedStartSettings(settings);
      setCurrentProjectPath(normalizedWorkspacePath);
      void updateCurrentProject(normalizedWorkspacePath)
        .then((current) => {
          if (current.project) upsertProject(current.project);
        })
        .catch(() => undefined);
      onStarted(result.task);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to start task'));
      setIsStarting(false);
    }
  }, [
    effectiveRuntime,
    model,
    normalizedWorkspacePath,
    onStarted,
    reasoningEffort,
    setCurrentProjectPath,
    startDisabled,
    task.id,
    taskMode,
    upsertProject,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>
            {queueLabel && <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{queueLabel}</p>}
            <p className="mt-1 truncate text-sm text-zinc-500 dark:text-zinc-400" title={task.title}>{task.title}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            aria-label="Close"
            title="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={17} />
          </button>
        </div>

        <div className="grid gap-4 px-5 py-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Project folder</div>
            <div className="flex items-center gap-2">
              <div
                className="min-w-0 flex-1 truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                title={normalizedWorkspacePath || 'No folder selected'}
              >
                {normalizedWorkspacePath || 'Choose the local repo folder for this machine'}
              </div>
              <button
                type="button"
                onClick={handleChooseWorkspace}
                disabled={isPickingWorkspace || isStarting}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                {isPickingWorkspace ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                Choose
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">AI runtime</div>
            <InputToolbar
              runtime={runtime}
              model={model}
              reasoningEffort={reasoningEffort}
              defaults={defaults}
              runtimeDefaultModel={runtimeDefaultModel}
              runtimeOptions={runtimeOptions}
              modelGroups={modelGroups}
              disabled={isStarting}
              onRuntimeChange={setRuntime}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Execution mode</div>
            <button
              type="button"
              onClick={() => setTaskMode((current) => current === 'plan' ? 'direct' : 'plan')}
              disabled={isStarting}
              aria-pressed={taskMode === 'plan'}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                taskMode === 'plan'
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
              }`}
            >
              <GitBranch size={13} />
              Plan mode
            </button>
          </div>

          {!normalizedWorkspacePath && (
            <p className="text-xs text-amber-600 dark:text-amber-300">Choose a project folder before starting.</p>
          )}
          {runtimeNeedsSetup && (
            <p className="text-xs text-amber-600 dark:text-amber-300">Selected runtime needs setup before it can run.</p>
          )}
          {planUnsupported && (
            <p className="text-xs text-red-500 dark:text-red-400">Plan mode is not available for this runtime.</p>
          )}
          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              disabled={isStarting}
              className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={isStarting}
            className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={startDisabled}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {isStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
