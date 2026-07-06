import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, FolderOpen, GitBranch, Loader2, X } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import { VoiceInputButton } from './VoiceInputButton';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  createComposerAttachments,
  type ComposerAttachment,
} from './AttachmentPicker';

import { createTask, deleteActivityContext, fetchActivityContext, pickWorkspaceDirectory, updateCurrentProject } from '../lib/api';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { clearActivityTaskDraft, createActivityTaskDraft, discardActivityTaskDraftOnPageUnload, loadActivityTaskDraft } from '../lib/activityDraft';
import { isEditableTarget, handleChatKeyDown } from '../lib/keyboard';
import { toErrorMessage } from '../lib/format';
import { announceTaskCreated, primeTaskCreatedNotifications, primeTaskCreatedSound } from '../lib/taskNotification';
import { useStore } from '../lib/store';
import { useOrganizations } from '../auth/OrganizationContext';
import { AssignmentControls } from './AssignmentControls';
import type { TaskMode } from '@shared/types';

const START_SETTINGS_STORAGE_KEY = 'bees:startTaskSettings';

interface SavedStartSettings {
  workspacePath?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  taskMode?: TaskMode;
}

function readSavedStartSettings(): SavedStartSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(START_SETTINGS_STORAGE_KEY) ?? '{}') as SavedStartSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function NewTaskPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activityDraftId = searchParams.get('activityDraft');
  const requestedWorkspacePath = searchParams.get('workspacePath')?.trim() ?? '';
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { selectedOrganization } = useOrganizations();
  const isOrgContext = selectedOrganization !== null;
  const [teamId, setTeamId] = useState('');
  const [assigneeEmail, setAssigneeEmail] = useState('');

  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const upsertTask = useStore((s) => s.upsertTask);
  const savedStartSettings = useMemo(readSavedStartSettings, []);
  const [workspacePath, setWorkspacePath] = useState(
    () => requestedWorkspacePath || savedStartSettings.workspacePath || currentProjectPath || localStorage.getItem('bees:lastWorkspacePath') || '',
  );
  const [pendingTaskMode, setPendingTaskMode] = useState<TaskMode>(savedStartSettings.taskMode ?? 'direct');
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);

  const { defaults, runtimeOptions, runtime, setRuntime, modelGroups, runtimeDefaultModel, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();

  const normalizedWorkspacePath = workspacePath.trim();
  const effectiveRuntime = runtime ?? defaults?.runtime ?? 'hermes';
  const runtimeMeta = runtimeOptions.find((o) => o.id === effectiveRuntime);
  const planUnsupported = pendingTaskMode === 'plan' && runtimeMeta?.supportsGoals === false;
  const toolbarDefaults = isLoading ? null : defaults;
  const configPending = isLoading && !defaults;

  const clearActivityDraftSearchParam = useCallback(() => {
    setSearchParams((currentParams) => {
      const next = new URLSearchParams(currentParams);
      next.delete('activityDraft');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!activityDraftId) return;

    function discardDraft() {
      discardActivityTaskDraftOnPageUnload(activityDraftId);
    }

    window.addEventListener('pagehide', discardDraft);
    window.addEventListener('beforeunload', discardDraft);
    return () => {
      window.removeEventListener('pagehide', discardDraft);
      window.removeEventListener('beforeunload', discardDraft);
    };
  }, [activityDraftId]);

  useEffect(() => {
    if (!activityDraftId) return;
    let cancelled = false;

    void (async () => {
      const localDraft = loadActivityTaskDraft(activityDraftId);
      let draft = null;

      try {
        const result = await fetchActivityContext(activityDraftId);
        draft = createActivityTaskDraft(result.context);
      } catch {
        draft = hasUsableActivityDraft(localDraft) ? localDraft : null;
      }

      if (cancelled) return;
      if (!draft) {
        clearActivityTaskDraft(activityDraftId);
        void deleteActivityContext(activityDraftId).catch(() => undefined);
        clearActivityDraftSearchParam();
        return;
      }

      const draftText = draft.text?.trim() ?? '';
      if (draftText) {
        setInput((current) => {
          if (!current.trim()) return draftText;
          if (current.includes(draftText)) return current;
          return `${current.trimEnd()}\n\n${draftText}`;
        });
      }

      if (draft.imagePath || draft.imageBase64) {
        const file = await loadActivityScreenshot(
          draft.imagePath,
          draft.imageName,
          draft.imageBase64,
          draft.imageMimeType,
        );
        if (!cancelled && file) {
          setAttachments((current) => (
            current.some((attachment) => attachment.file.name === file.name && attachment.file.size === file.size)
              ? current
              : [...current, ...createComposerAttachments([file])]
          ));
        }
      }

      if (cancelled) return;
      clearActivityTaskDraft(draft.id);
      void deleteActivityContext(draft.id).catch(() => undefined);
      clearActivityDraftSearchParam();
    })();

    return () => {
      cancelled = true;
    };
  }, [activityDraftId, clearActivityDraftSearchParam]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isCreating) return;
    setIsPickingWorkspace(true);
    setWorkspaceError(null);
    try {
      const result = await pickWorkspaceDirectory(normalizedWorkspacePath || null);
      if (result.path) {
        setWorkspacePath(result.path);
        setCurrentProjectPath(result.path);
        localStorage.setItem(START_SETTINGS_STORAGE_KEY, JSON.stringify({
          ...readSavedStartSettings(),
          workspacePath: result.path,
        }));
        void updateCurrentProject(result.path)
          .then((current) => {
            if (current.project) upsertProject(current.project);
          })
          .catch(() => undefined);
      }
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to choose project folder'));
    } finally {
      setIsPickingWorkspace(false);
    }
  }, [isPickingWorkspace, isCreating, normalizedWorkspacePath, setCurrentProjectPath, upsertProject]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const files = attachments.map((attachment) => attachment.file);
    if ((!text && files.length === 0) || isCreating) return;
    primeTaskCreatedSound();
    primeTaskCreatedNotifications();
    setIsCreating(true);
    setWorkspaceError(null);
    try {
      const created = await createTask(
        text || (files.length === 1 ? 'Attached file.' : 'Attached files.'),
        undefined,
        normalizedWorkspacePath || undefined,
        runtime,
        model,
        reasoningEffort,
        pendingTaskMode,
        files,
        'task',
        undefined,
        isOrgContext ? { teamId: teamId || null, assigneeEmail: assigneeEmail || null } : undefined,
      );
      const task = created.task;
      upsertTask(task);

      if (!isOrgContext) {
        localStorage.setItem(START_SETTINGS_STORAGE_KEY, JSON.stringify({
          ...readSavedStartSettings(),
          ...(normalizedWorkspacePath ? { workspacePath: normalizedWorkspacePath } : {}),
          runtime,
          model,
          reasoningEffort,
          taskMode: pendingTaskMode,
        }));
      }
      announceTaskCreated(`Task created: ${task.title}`, task.id);
      navigate(`/tasks/${task.id}`, {
        state: isOrgContext ? undefined : { initialSettings: { runtime, model, reasoningEffort } },
      });
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to create task'));
      setIsCreating(false);
    }
  }, [
    assigneeEmail,
    attachments,
    input,
    isCreating,
    isOrgContext,
    model,
    navigate,
    normalizedWorkspacePath,
    pendingTaskMode,
    reasoningEffort,
    runtime,
    teamId,
    upsertTask,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  const handleFormSubmit = useCallback((event: React.BaseSyntheticEvent) => {
    event.preventDefault();
    void handleSubmit();
  }, [handleSubmit]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isCreating) return;

    const pastedAttachments = composerAttachmentsFromClipboard(event);
    if (pastedAttachments.length === 0) return;

    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    setAttachments((current) => [...current, ...pastedAttachments]);
  }, [isCreating]);

  const handleVoiceTranscript = useCallback((text: string) => {
    const target = inputRef.current;
    const start = target?.selectionStart ?? input.length;
    const end = target?.selectionEnd ?? input.length;
    const prefix = input.slice(0, start);
    const suffix = input.slice(end);
    const before = prefix && !/\s$/.test(prefix) ? ' ' : '';
    const after = suffix && !/^\s/.test(suffix) ? ' ' : '';
    const next = `${prefix}${before}${text}${after}${suffix}`;
    const cursor = prefix.length + before.length + text.length + after.length;

    setInput(next);
    setVoiceError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }, [input]);


  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">
        What do you need done?
      </h1>

      <form className="w-full max-w-4xl" onSubmit={handleFormSubmit}>
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm overflow-hidden">
          {!isOrgContext && normalizedWorkspacePath && (
            <div className="flex items-start justify-between gap-3 border-b border-zinc-100 bg-zinc-50/70 px-5 py-3 dark:border-zinc-700/70 dark:bg-zinc-900/40">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Working directory
                </p>
                <p className="mt-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-200" title={normalizedWorkspacePath}>
                  {normalizedWorkspacePath}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWorkspacePath('')}
                disabled={isCreating || isPickingWorkspace}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
                aria-label="Clear working directory"
                title="Clear working directory"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <AttachmentPreviewList
            attachments={attachments}
            disabled={isCreating}
            onChange={setAttachments}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Describe your task in detail..."
            rows={4}
            className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between gap-3 px-4 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <AttachmentPicker
                attachments={attachments}
                disabled={isCreating}
                onChange={setAttachments}
              />
              <VoiceInputButton
                disabled={isCreating}
                onTranscript={handleVoiceTranscript}
                onError={setVoiceError}
              />
              {isOrgContext ? (
                <AssignmentControls
                  teamId={teamId}
                  assigneeEmail={assigneeEmail}
                  disabled={isCreating}
                  compact
                  onTeamChange={setTeamId}
                  onAssigneeChange={setAssigneeEmail}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setPendingTaskMode((current) => current === 'plan' ? 'direct' : 'plan')}
                    disabled={isCreating || configPending}
                    aria-pressed={pendingTaskMode === 'plan'}
                    title={pendingTaskMode === 'plan' ? 'Switch to direct mode' : 'Switch to plan mode'}
                    className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      pendingTaskMode === 'plan'
                        ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/40'
                        : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70'
                    }`}
                  >
                    <GitBranch size={12} className="shrink-0" />
                    <span>Plan mode</span>
                  </button>
                  <InputToolbar
                    runtime={runtime}
                    model={model}
                    reasoningEffort={reasoningEffort}
                    defaults={toolbarDefaults}
                    runtimeDefaultModel={runtimeDefaultModel}
                    runtimeOptions={runtimeOptions}
                    modelGroups={modelGroups}
                    disabled={isCreating || configPending}
                    onRuntimeChange={setRuntime}
                    onModelChange={setModel}
                    onReasoningEffortChange={setReasoningEffort}
                  />
                  <button
                    type="button"
                    onClick={handleChooseWorkspace}
                    disabled={isCreating || isPickingWorkspace || configPending}
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
                    aria-label="Choose working directory"
                    title="Choose working directory"
                  >
                    {isPickingWorkspace ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                    <span>Choose Folder</span>
                  </button>
                </>
              )}
            </div>
            <button
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || isCreating}
              className="p-2.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              aria-label="Create and start task"
              title="Create and start task"
              data-testid="create-start-task-button"
            >
              {isCreating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
          {workspaceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">
                {workspaceError}
              </p>
            </div>
          )}
          {!isOrgContext && planUnsupported && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">Plan mode is not available for this runtime.</p>
            </div>
          )}
          {voiceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">
                {voiceError}
              </p>
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-3">
          {isOrgContext
            ? 'The assignee chooses the project folder and AI settings when starting the task.'
            : 'Optionally choose a folder and AI settings, or set them when starting the task.'}
        </p>
      </form>
    </div>
  );
}

async function loadActivityScreenshot(
  path?: string,
  name?: string,
  base64?: string,
  mimeType?: string,
): Promise<File | null> {
  if (base64) {
    const file = fileFromBase64(base64, name || path?.split(/[\\/]/).pop() || 'activity-screenshot.png', mimeType);
    if (file) return file;
  }

  if (!path) return null;

  try {
    const response = await fetch(`/api/files/view?path=${encodeURIComponent(path)}`);
    if (!response.ok) return null;

    const blob = await response.blob();
    const fileName = name || path.split(/[\\/]/).pop() || 'activity-screenshot.png';
    return new File([blob], fileName, {
      type: blob.type || 'image/png',
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

function fileFromBase64(base64: string, name: string, mimeType = 'image/png'): File | null {
  try {
    const normalized = base64.replace(/^data:[^;,]+;base64,/, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], ensureImageExtension(name, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

function hasUsableActivityDraft(draft: ReturnType<typeof loadActivityTaskDraft>): draft is NonNullable<ReturnType<typeof loadActivityTaskDraft>> {
  return Boolean(
    draft
    && (
      draft.text?.trim()
      || draft.imagePath?.trim()
      || draft.imageBase64?.trim()
    ),
  );
}

function ensureImageExtension(name: string, mimeType: string): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  return `${name}.${extensionForMimeType(mimeType)}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}
