import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { ArrowUp, Loader2, ChevronDown, ChevronRight, Check, Terminal, FileText, FilePenLine, Globe, Code, Wrench, Image as ImageIcon, X, FolderOpen, GitBranch } from 'lucide-react';
import { InputToolbar, ContextRing } from './InputToolbar';
import { VoiceInputButton } from './VoiceInputButton';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  type ComposerAttachment,
} from './AttachmentPicker';
import { ArtifactViewer, ChatArtifacts, collectChatArtifacts, type ChatArtifact } from './ChatArtifacts';
import { MarkdownContent } from './MarkdownContent';
import { useChat, ToolProgressEvent } from '../hooks/useChat';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { handleChatKeyDown } from '../lib/keyboard';
import { BASE, fileViewUrl, patchTask, pickWorkspaceDirectory, startTask, updateCurrentProject } from '../lib/api';
import { useStore } from '../lib/store';
import { toErrorMessage } from '../lib/format';
import { readSavedStartSettings, writeSavedStartSettings } from '../lib/startTaskSettings';
import type { AgentRunSettings } from '../lib/api';
import type { AgentRuntime, ChatAttachment, LiveChatTimelineItem, ReasoningEffort, TaskMode, TaskStatus } from '@shared/types';

interface TaskChatProps {
  taskId: string;
  taskStatus: TaskStatus;
  taskMode?: TaskMode;
  taskDescription?: string | null;
  initialMessage?: string;
  initialSettings?: AgentRunSettings;
  emptyMessage?: string;
  inputPlaceholder?: string;
  workspacePath?: string | null;
  onAgentSettingsChange?: (settings: { runtime: AgentRuntime | null; model: string | null }) => void;
}

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  if (!content) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isLive ? 'Thinking…' : 'Thought process'}</span>
        {isLive && <Loader2 size={10} className="animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 pl-4 py-1 border-l-2 border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400 dark:text-zinc-500 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePenLine,
  patch: FilePenLine,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
  browser_navigate: Globe,
  browser_snapshot: Globe,
  browser_vision: Globe,
};

const CHAT_COLUMN_CLASS = 'w-full max-w-[760px] mx-auto';
const ATTACHMENT_CONTEXT_PATTERN = /\n*\s*The user attached the following file(?:s)?\.[\s\S]*?<attachments>[\s\S]*?<\/attachments>\s*$/;
const ATTACHMENTS_PATTERN = /<attachments>[\s\S]*?<\/attachments>/;
const ACTIVITY_CONTEXT_SECTION_PATTERN = /\n*(?:Captured selected text|Active window|Captured image context is available for inspection):[\s\S]*?(?=\n\n(?:Captured selected text|Active window|Captured image context is available for inspection):|$)/gi;

function getToolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function displayMessageContent(content: string): string {
  return stripActivityContextSections(content.replace(ATTACHMENT_CONTEXT_PATTERN, '')).trim();
}

function stripActivityContextSections(content: string): string {
  const withoutActivitySections = content.replace(ACTIVITY_CONTEXT_SECTION_PATTERN, '');
  const userRequestMatch = withoutActivitySections.match(/^\s*User request:\s*\n([\s\S]*?)\s*$/i);
  if (userRequestMatch) return userRequestMatch[1];
  return withoutActivitySections;
}

function parseMessageAttachments(content: string): ChatAttachment[] {
  const match = content.match(ATTACHMENTS_PATTERN);
  if (!match || typeof DOMParser === 'undefined') return [];

  const document = new DOMParser().parseFromString(match[0], 'application/xml');
  if (document.querySelector('parsererror')) return [];

  return Array.from(document.querySelectorAll('attachment')).map((element, index) => {
    const text = (tagName: string) => element.querySelector(tagName)?.textContent ?? '';
    const mimeType = text('mime_type') || 'application/octet-stream';
    const attachmentId = text('attachment_id');
    const path = text('absolute_path');
    const viewUrl = text('view_url');
    const downloadUrl = text('download_url');
    const name = text('name') || path.split(/[\\/]/).pop() || 'attachment';
    const size = Number(text('size_bytes'));
    const kind: ChatAttachment['kind'] = element.getAttribute('kind') === 'image' || mimeType.startsWith('image/')
      ? 'image'
      : 'file';

    return {
      id: attachmentId || `${path || viewUrl || name}-${index}`,
      name,
      path,
      viewUrl,
      downloadUrl,
      mimeType,
      size: Number.isFinite(size) ? size : 0,
      kind,
    };
  }).filter((attachment) => attachment.path || attachment.viewUrl);
}

function displayMessageAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments;
}

function apiAttachmentUrl(url: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const enterpriseMatch = url.match(/^\/organization\/([^/]+)\/tasks\/([^/]+)\/attachments\/([^/]+)\/(view|download)$/);
  if (enterpriseMatch) {
    const [, organizationId, taskId, attachmentId, action] = enterpriseMatch;
    return `${BASE}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/${action}?organizationId=${encodeURIComponent(organizationId)}`;
  }
  return url.startsWith(BASE) ? url : `${BASE}${url.startsWith('/') ? url : `/${url}`}`;
}

function attachmentViewHref(attachment: ChatAttachment): string {
  return attachment.viewUrl ? apiAttachmentUrl(attachment.viewUrl) : fileViewUrl(attachment.path);
}

function attachmentDownloadHref(attachment: ChatAttachment): string {
  return attachment.downloadUrl ? apiAttachmentUrl(attachment.downloadUrl) : attachmentViewHref(attachment);
}

function MessageAttachmentList({
  attachments,
  onOpenImage,
}: {
  attachments: ChatAttachment[];
  onOpenImage: (attachment: ChatAttachment) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-2 grid max-w-full gap-2">
      {attachments.map((attachment) => {
        const isImage = attachment.kind === 'image' || attachment.mimeType.startsWith('image/');
        const href = attachmentViewHref(attachment);

        if (isImage) {
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => onOpenImage(attachment)}
              className="group overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
              title={`Open ${attachment.name}`}
            >
              <img
                src={href}
                alt={attachment.name}
                className="max-h-56 w-full max-w-sm bg-zinc-100 object-contain dark:bg-zinc-950"
                loading="lazy"
              />
              <span className="flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                <ImageIcon size={14} className="shrink-0" />
                <span className="min-w-0 truncate">{attachment.name}</span>
              </span>
            </button>
          );
        }

        return (
          <a
            key={attachment.id}
            href={attachmentDownloadHref(attachment)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-sm items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title={`Open ${attachment.name}`}
          >
            <FileText size={14} className="shrink-0 text-zinc-400" />
            <span className="min-w-0 truncate">{attachment.name}</span>
          </a>
        );
      })}
    </div>
  );
}

function ImageAttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20"
        onClick={onClose}
        aria-label="Close image"
        title="Close"
      >
        <X size={18} />
      </button>
      <img
        src={attachmentViewHref(attachment)}
        alt={attachment.name}
        className="max-h-[88vh] max-w-[92vw] rounded-lg bg-white object-contain shadow-2xl dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      />
      <div className="absolute bottom-4 left-4 right-4 mx-auto max-w-xl truncate rounded-lg bg-zinc-950/70 px-3 py-2 text-center text-xs text-white">
        {attachment.name}
      </div>
    </div>
  );
}

function stringDetail(details: unknown, key: string): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function numberDetail(details: unknown, key: string): number | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function argsDetail(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const value = (details as Record<string, unknown>).args;
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function detailText(details: unknown): string {
  if (details == null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function ProcessDetails({ tool }: { tool: ToolProgressEvent }) {
  const command = stringDetail(tool.details, 'command') ?? tool.label ?? '';
  const cwd = stringDetail(tool.details, 'cwd');
  const promptFile = stringDetail(tool.details, 'promptFile');
  const contextFile = stringDetail(tool.details, 'contextFile');
  const stdoutTail = stringDetail(tool.details, 'stdoutTail');
  const stderrTail = stringDetail(tool.details, 'stderrTail');
  const elapsed = numberDetail(tool.details, 'elapsedSeconds');
  const exitCode = numberDetail(tool.details, 'exitCode');
  const args = argsDetail(tool.details);

  return (
    <div className="border-t border-zinc-200 px-4 py-3 text-xs dark:border-zinc-800">
      <div className="grid min-w-0 gap-2">
        {command && (
          <div className="min-w-0">
            <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">Command</div>
            <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-zinc-700 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-300">{command}</pre>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {cwd && (
            <div className="min-w-0">
              <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">Working directory</div>
              <pre className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-zinc-700 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-300" title={cwd}>{cwd}</pre>
            </div>
          )}
          <div className="min-w-0">
            <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">Status</div>
            <div className="rounded-md bg-zinc-100 p-2 font-mono text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
              {tool.status}{elapsed != null ? ` - ${elapsed.toFixed(1)}s` : ''}{exitCode != null ? ` - exit ${exitCode}` : ''}
            </div>
          </div>
        </div>
        {(promptFile || contextFile) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {promptFile && (
              <div className="min-w-0">
                <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">Prompt</div>
                <pre className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-zinc-500 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-400" title={promptFile}>{promptFile}</pre>
              </div>
            )}
            {contextFile && (
              <div className="min-w-0">
                <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">Context</div>
                <pre className="max-h-24 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-zinc-500 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-400" title={contextFile}>{contextFile}</pre>
              </div>
            )}
          </div>
        )}
        {args.length > 0 && (
          <details className="rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
            <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400">Arguments</summary>
            <pre className="mt-2 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">{args.join('\n')}</pre>
          </details>
        )}
        {stdoutTail && (
          <div className="min-w-0">
            <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">stdout</div>
            <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-2 font-mono text-zinc-100 [overflow-wrap:anywhere]">{stdoutTail}</pre>
          </div>
        )}
        {stderrTail && (
          <div className="min-w-0">
            <div className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">stderr</div>
            <pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-2 font-mono text-red-200 [overflow-wrap:anywhere]">{stderrTail}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function compactTimeline(items: LiveChatTimelineItem[]): LiveChatTimelineItem[] {
  const sorted = [...items].sort((a, b) => a.created_at - b.created_at);
  const compacted: LiveChatTimelineItem[] = [];

  for (const item of sorted) {
    const previous = compacted[compacted.length - 1];
    if (
      (item.type === 'text' || item.type === 'thinking') &&
      previous &&
      previous.type === item.type &&
      previous.content.length < 2200
    ) {
      previous.content += item.content;
      continue;
    }
    compacted.push(item.type === 'tool' ? { ...item, tool: { ...item.tool } } : { ...item });
  }

  return compacted;
}

function TimelineTextBlock({ item }: { item: Extract<LiveChatTimelineItem, { type: 'text' | 'thinking' }> }) {
  const isThinking = item.type === 'thinking';
  return (
    <div className={isThinking ? 'rounded-lg border-l-2 border-zinc-200 py-1 pl-3 dark:border-zinc-700' : ''}>
      {isThinking && (
        <div className="mb-1 text-xs font-medium text-zinc-400 dark:text-zinc-500">Thinking</div>
      )}
      <div className={isThinking ? 'text-xs leading-relaxed text-zinc-400 dark:text-zinc-500' : 'text-sm leading-relaxed text-zinc-700 dark:text-zinc-300'}>
        <MarkdownContent content={item.content} isStreaming />
      </div>
    </div>
  );
}

function TimelineErrorBlock({ item }: { item: Extract<LiveChatTimelineItem, { type: 'error' }> }) {
  return (
    <div className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:text-red-400">
      {item.error}
    </div>
  );
}

function ActivityTimeline({ items }: { items: LiveChatTimelineItem[] }) {
  const compacted = compactTimeline(items);
  if (compacted.length === 0) return null;

  return (
    <div className="mb-4 space-y-2.5">
      {compacted.map((item) => {
        if (item.type === 'tool') return <ToolCallBlock key={item.id} tool={item.tool} />;
        if (item.type === 'error') return <TimelineErrorBlock key={item.id} item={item} />;
        return <TimelineTextBlock key={item.id} item={item} />;
      })}
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: ToolProgressEvent }) {
  const [expanded, setExpanded] = useState(tool.tool === 'process' && tool.status === 'error');
  const Icon = getToolIcon(tool.tool);
  const hasDetails = tool.details != null;
  const canExpand = hasDetails || tool.tool === 'process';
  const body = tool.tool === 'process' ? <ProcessDetails tool={tool} /> : (
    <pre className="border-t border-zinc-200 px-4 py-3 whitespace-pre-wrap break-words font-mono text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
      {detailText(tool.details)}
    </pre>
  );

  return (
    <div className={`overflow-hidden rounded-xl border ${
      tool.status === 'error'
        ? 'border-red-200 dark:border-red-900'
        : 'border-zinc-200 dark:border-zinc-700'
    }`}>
      <button
        type="button"
        onClick={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left disabled:cursor-default"
        title={canExpand ? 'Show process details' : undefined}
      >
        {canExpand ? (
          expanded ? <ChevronDown size={14} className="shrink-0 text-zinc-400" /> : <ChevronRight size={14} className="shrink-0 text-zinc-400" />
        ) : (
          <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
        )}
        {canExpand && <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />}
        <span className={`text-sm font-medium shrink-0 ${
          tool.status === 'error'
            ? 'text-red-500 dark:text-red-400'
            : 'text-zinc-600 dark:text-zinc-300'
        }`}>
          {formatToolName(tool.tool)}
        </span>
        {tool.label && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono truncate min-w-0">
            {tool.label}
          </span>
        )}
        {tool.status === 'running' && <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" />}
        {tool.status === 'completed' && <Check size={14} className="text-zinc-400 shrink-0" />}
        {tool.duration != null && (
          <span className="text-xs text-zinc-300 dark:text-zinc-600 ml-auto shrink-0 tabular-nums">
            {tool.duration.toFixed(1)}s
          </span>
        )}
      </button>
      {expanded && (
        body
      )}
    </div>
  );
}

export function TaskChat({
  taskId,
  taskStatus,
  taskMode = 'direct',
  taskDescription,
  initialMessage,
  initialSettings,
  emptyMessage = 'Start a conversation with your assistant.',
  inputPlaceholder = 'Message your assistant...',
  workspacePath,
  onAgentSettingsChange,
}: TaskChatProps) {
  const savedStartSettings = useMemo(readSavedStartSettings, [taskId]);
  const { messages, isStreaming, thinkingContent, activeTools, context, sendMessage, loadMessages } = useChat();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<ChatAttachment | null>(null);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [messagesLoadError, setMessagesLoadError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const upsertTask = useStore((s) => s.upsertTask);
  const [pendingWorkspacePath, setPendingWorkspacePath] = useState(
    workspacePath ?? savedStartSettings.workspacePath ?? currentProjectPath ?? localStorage.getItem('bees:lastWorkspacePath') ?? '',
  );
  const [pendingTaskMode, setPendingTaskMode] = useState<TaskMode>(taskMode ?? savedStartSettings.taskMode ?? 'direct');
  const [activeWorkspacePath, setActiveWorkspacePath] = useState(workspacePath ?? '');
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [isStartingTask, setIsStartingTask] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startupRef = useRef({ taskId, initialMessage, initialSettings });
  if (startupRef.current.taskId !== taskId) {
    startupRef.current = { taskId, initialMessage, initialSettings };
  }
  const { defaults, runtimeOptions, runtime, setRuntime, modelGroups, runtimeDefaultModel, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig(
    taskId,
    startupRef.current.initialSettings ?? {
      runtime: savedStartSettings.runtime ?? null,
      model: savedStartSettings.model ?? null,
      reasoningEffort: savedStartSettings.reasoningEffort ?? null,
    },
  );
  const waitingForTaskSettings = isLoading && !startupRef.current.initialSettings;
  const toolbarDefaults = waitingForTaskSettings ? null : defaults;
  const configPending = waitingForTaskSettings || (!defaults && isLoading);
  const isInactiveTask = taskStatus === 'pending' || taskStatus === 'assigned';
  const messageControlsDisabled = configPending || isStartingTask;
  const runtimeControlsDisabled = configPending || isStartingTask;
  const normalizedPendingWorkspacePath = pendingWorkspacePath.trim();
  const normalizedActiveWorkspacePath = activeWorkspacePath.trim();
  const displayWorkspacePath = isInactiveTask ? normalizedPendingWorkspacePath : normalizedActiveWorkspacePath;
  const effectiveRuntime = runtime ?? defaults?.runtime ?? 'hermes';
  const runtimeMeta = runtimeOptions.find((option) => option.id === effectiveRuntime);
  const runtimeNeedsSetup = runtimeMeta?.status === 'configure';
  const planUnsupported = pendingTaskMode === 'plan' && runtimeMeta?.supportsGoals === false;
  const sendDisabled = isInactiveTask
    ? runtimeControlsDisabled || !normalizedPendingWorkspacePath || runtimeNeedsSetup || planUnsupported
    : runtimeControlsDisabled || isStreaming;
  const onAgentSettingsChangeRef = useRef(onAgentSettingsChange);
  onAgentSettingsChangeRef.current = onAgentSettingsChange;
  const displayModel = model ?? runtimeDefaultModel ?? defaults?.model ?? null;
  useEffect(() => {
    if (configPending) return;
    onAgentSettingsChangeRef.current?.({ runtime: effectiveRuntime, model: displayModel });
  }, [configPending, effectiveRuntime, displayModel]);
  const taskDescriptionAttachments = useMemo(
    () => taskDescription ? displayMessageAttachments(parseMessageAttachments(taskDescription)) : [],
    [taskDescription],
  );
  const taskDescriptionAttachmentKeys = useMemo(
    () => new Set(taskDescriptionAttachments.map((attachment) => attachment.path)),
    [taskDescriptionAttachments],
  );
  const showTaskDescriptionBubble = Boolean(
    taskDescription
    && taskDescriptionAttachments.length > 0
    && !messages.some((message) => (
      message.role === 'user'
      && parseMessageAttachments(message.content).some((attachment) => taskDescriptionAttachmentKeys.has(attachment.path))
    )),
  );
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadedTaskId(null);
    setMessagesLoadError(null);
    setSelectedArtifact(null);
    setSelectedAttachment(null);
    setStartError(null);
    didInitialScrollRef.current = false;
    loadMessages(taskId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        const firstMessage = startupRef.current.initialMessage;
        if (firstMessage) {
          startupRef.current.initialMessage = undefined;
          if (loadedMessages.length === 0 && taskStatus !== 'pending' && taskStatus !== 'assigned') {
            sendMessage(taskId, firstMessage, startupRef.current.initialSettings);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        setMessagesLoadError(toErrorMessage(err, 'Failed to load messages.'));
      });
    inputRef.current?.focus();
    return () => { cancelled = true; };
  }, [taskId, taskStatus, loadMessages, sendMessage]);

  useEffect(() => {
    setPendingWorkspacePath(
      workspacePath ?? savedStartSettings.workspacePath ?? currentProjectPath ?? localStorage.getItem('bees:lastWorkspacePath') ?? '',
    );
    setActiveWorkspacePath(workspacePath ?? '');
    setPendingTaskMode(taskMode ?? savedStartSettings.taskMode ?? 'direct');
    setStartError(null);
  }, [currentProjectPath, savedStartSettings, taskId, taskMode, workspacePath]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || didInitialScrollRef.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    didInitialScrollRef.current = true;
  }, [loadedTaskId, messages.length, taskId]);

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isStartingTask) return;
    setIsPickingWorkspace(true);
    setStartError(null);

    try {
      const initialPath = isInactiveTask
        ? normalizedPendingWorkspacePath || null
        : normalizedActiveWorkspacePath || currentProjectPath || localStorage.getItem('bees:lastWorkspacePath') || null;
      const result = await pickWorkspaceDirectory(initialPath);
      if (!result.path) return;

      if (isInactiveTask) {
        setPendingWorkspacePath(result.path);
        return;
      }

      setActiveWorkspacePath(result.path);
      const updated = await patchTask(taskId, { workspacePath: result.path });
      upsertTask(updated.task);
      setCurrentProjectPath(result.path);
      localStorage.setItem('bees:lastWorkspacePath', result.path);
      void updateCurrentProject(result.path)
        .then((current) => {
          if (current.project) upsertProject(current.project);
        })
        .catch(() => undefined);
    } catch (error) {
      setStartError(toErrorMessage(error, 'Failed to choose project folder'));
    } finally {
      setIsPickingWorkspace(false);
    }
  }, [
    currentProjectPath,
    isInactiveTask,
    isPickingWorkspace,
    isStartingTask,
    normalizedActiveWorkspacePath,
    normalizedPendingWorkspacePath,
    setCurrentProjectPath,
    taskId,
    upsertProject,
    upsertTask,
  ]);

  const handleStartTask = useCallback(async () => {
    if (!isInactiveTask || sendDisabled) return;

    setIsStartingTask(true);
    setStartError(null);
    try {
      const text = input.trim();
      const files = attachments.map((attachment) => attachment.file);
      const settings = {
        workspacePath: normalizedPendingWorkspacePath,
        runtime: effectiveRuntime,
        model,
        reasoningEffort,
        taskMode: pendingTaskMode,
      };
      const result = await startTask(taskId, settings, text || undefined, files);
      writeSavedStartSettings(settings);
      upsertTask(result.task);
      setInput('');
      setAttachments([]);
      for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setCurrentProjectPath(normalizedPendingWorkspacePath);
      void updateCurrentProject(normalizedPendingWorkspacePath)
        .then((current) => {
          if (current.project) upsertProject(current.project);
        })
        .catch(() => undefined);
    } catch (error) {
      setStartError(toErrorMessage(error, 'Failed to start task'));
    } finally {
      setIsStartingTask(false);
    }
  }, [
    effectiveRuntime,
    attachments,
    input,
    isInactiveTask,
    model,
    normalizedPendingWorkspacePath,
    pendingTaskMode,
    reasoningEffort,
    sendDisabled,
    setCurrentProjectPath,
    taskId,
    upsertProject,
    upsertTask,
  ]);

  const handleSubmit = useCallback(async () => {
    if (isInactiveTask) {
      await handleStartTask();
      return;
    }

    const text = input.trim();
    const files = attachments.map((attachment) => attachment.file);
    if ((!text && files.length === 0) || sendDisabled) return;
    const messageText = text || (files.length === 1 ? 'Attached file.' : 'Attached files.');
    setInput('');
    setAttachments([]);
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    await sendMessage(taskId, messageText, { runtime, model, reasoningEffort }, files);
  }, [attachments, handleStartTask, input, isInactiveTask, sendDisabled, taskId, sendMessage, runtime, model, reasoningEffort]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (messageControlsDisabled) return;

    const pastedAttachments = composerAttachmentsFromClipboard(event);
    if (pastedAttachments.length === 0) return;

    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    setAttachments((current) => [...current, ...pastedAttachments]);
  }, [messageControlsDisabled]);

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
    <div className="flex w-full flex-1 min-h-0">
      <div className={`flex min-w-0 flex-col transition-[width,flex-basis] duration-200 ${
        selectedArtifact ? 'basis-full xl:basis-[50%] 2xl:basis-[54%]' : 'basis-full'
      }`}>
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto px-4 sm:px-6 py-4"
        >
          <div className={`${CHAT_COLUMN_CLASS} space-y-3`}>
            {messages.length === 0 && !showTaskDescriptionBubble && messagesLoadError && (
              <p className="text-sm text-red-400 dark:text-red-500 text-center py-12">{messagesLoadError}</p>
            )}
            {messages.length === 0 && !showTaskDescriptionBubble && !messagesLoadError && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500 text-center py-12">
                {isInactiveTask
                  ? 'Choose the folder and AI settings below, then start this task.'
                  : emptyMessage}
              </p>
            )}
            {showTaskDescriptionBubble && taskDescription && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 text-sm leading-relaxed text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
                  {displayMessageContent(taskDescription) && (
                    <div className="whitespace-pre-wrap">{displayMessageContent(taskDescription)}</div>
                  )}
                  <MessageAttachmentList
                    attachments={taskDescriptionAttachments}
                    onOpenImage={setSelectedAttachment}
                  />
                </div>
              </div>
            )}
            {messages.map((msg, idx) => {
              if (msg.role === 'user') {
                const userContent = displayMessageContent(msg.content);
                const messageAttachments = displayMessageAttachments(parseMessageAttachments(msg.content));
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 text-sm leading-relaxed text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
                      {userContent && <div className="whitespace-pre-wrap">{userContent}</div>}
                      <MessageAttachmentList
                        attachments={messageAttachments}
                        onOpenImage={setSelectedAttachment}
                      />
                    </div>
                  </div>
                );
              }

              const isLastAssistant = idx === messages.length - 1 && msg.role === 'assistant';
              const timelineToShow = isLastAssistant ? msg.timeline ?? [] : [];
              const showTimeline = timelineToShow.length > 0;
              const thinkingToShow = isLastAssistant && isStreaming ? thinkingContent : (msg.thinking || '');
              const isLiveThinking = isLastAssistant && isStreaming && !!thinkingContent;
              const toolsToShow = showTimeline ? [] : isLastAssistant && isStreaming ? activeTools : (msg.tools ?? []);
              const artifacts = collectChatArtifacts(msg.content, toolsToShow, timelineToShow);
              const showSpinner = isLastAssistant && isStreaming && !msg.content && !thinkingContent && !activeTools.some(t => t.status === 'running');

              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="w-full px-1 sm:px-2">
                    {showTimeline ? (
                      <ActivityTimeline items={timelineToShow} />
                    ) : thinkingToShow && (
                      <ThinkingBlock content={thinkingToShow} isLive={isLiveThinking} />
                    )}
                    {!showTimeline && toolsToShow.length > 0 && (
                      <div className="mb-4 space-y-2.5">
                        {toolsToShow.map((tool, i) => (
                          <ToolCallBlock key={`${tool.tool}-${i}`} tool={tool} />
                        ))}
                      </div>
                    )}
                    <ChatArtifacts artifacts={artifacts} onOpenArtifact={setSelectedArtifact} />
                    {!showTimeline && <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {msg.content ? (
                        <MarkdownContent content={msg.content} isStreaming={isLastAssistant && isStreaming} />
                      ) : (
                        showSpinner && (
                          <span className="inline-flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
                            <span>Thinking</span>
                            <span className="inline-flex gap-1">
                              {[0, 150, 300].map((delay) => (
                                <span
                                  key={delay}
                                  className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                                  style={{ animationDelay: `${delay}ms` }}
                                />
                              ))}
                            </span>
                          </span>
                        )
                      )}
                    </div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-4 border-t border-zinc-100 dark:border-zinc-800">
        <div className="w-full max-w-[800px] mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
          {displayWorkspacePath && (
            <div className="flex items-start justify-between gap-3 border-b border-zinc-100 bg-zinc-50/70 px-5 py-3 dark:border-zinc-700/70 dark:bg-zinc-900/40">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Working directory
                </p>
                <p className="mt-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-200" title={displayWorkspacePath}>
                  {displayWorkspacePath}
                </p>
              </div>
              {isInactiveTask && (
                <button
                  type="button"
                  onClick={() => setPendingWorkspacePath('')}
                  disabled={runtimeControlsDisabled || isPickingWorkspace}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
                  aria-label="Clear working directory"
                  title="Clear working directory"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <AttachmentPreviewList
            attachments={attachments}
            disabled={messageControlsDisabled}
            onChange={setAttachments}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isInactiveTask ? 'Add planning context, requirements, screenshots, or notes before starting...' : inputPlaceholder}
            rows={2}
            disabled={messageControlsDisabled}
            className="w-full resize-none bg-transparent px-5 pt-3 pb-1 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
              <AttachmentPicker
                attachments={attachments}
                disabled={messageControlsDisabled}
                onChange={setAttachments}
              />
              <VoiceInputButton
                disabled={messageControlsDisabled}
                onTranscript={handleVoiceTranscript}
                onError={setVoiceError}
              />
              {isInactiveTask && (
                <button
                  type="button"
                  onClick={() => setPendingTaskMode((current) => current === 'plan' ? 'direct' : 'plan')}
                  disabled={runtimeControlsDisabled}
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
              )}
              <InputToolbar
                runtime={runtime}
                model={model}
                reasoningEffort={reasoningEffort}
                defaults={toolbarDefaults}
                runtimeDefaultModel={runtimeDefaultModel}
                runtimeOptions={runtimeOptions}
                modelGroups={modelGroups}
                disabled={runtimeControlsDisabled}
                onRuntimeChange={setRuntime}
                onModelChange={setModel}
                onReasoningEffortChange={setReasoningEffort}
              />
              <button
                type="button"
                onClick={handleChooseWorkspace}
                disabled={runtimeControlsDisabled || isPickingWorkspace || isStreaming}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
                aria-label="Choose working directory"
                title="Choose working directory"
              >
                {isPickingWorkspace ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                <span>Choose Folder</span>
              </button>
            </div>
            <div className="flex items-center gap-2">
              {context && <ContextRing context={context} />}
              <button
                onClick={handleSubmit}
                disabled={isInactiveTask ? sendDisabled : ((!input.trim() && attachments.length === 0) || sendDisabled)}
                aria-label={isInactiveTask ? 'Start task' : 'Send message'}
                title={isInactiveTask ? 'Start task' : 'Send message'}
                className="p-2 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              >
                {isStartingTask ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
              </button>
            </div>
          </div>
          {isInactiveTask && !normalizedPendingWorkspacePath && (
            <div className="px-4 pb-3">
              <p className="text-xs text-amber-600 dark:text-amber-300">Choose a project folder before starting.</p>
            </div>
          )}
          {isInactiveTask && runtimeNeedsSetup && (
            <div className="px-4 pb-3">
              <p className="text-xs text-amber-600 dark:text-amber-300">Selected runtime needs setup before it can run.</p>
            </div>
          )}
          {isInactiveTask && planUnsupported && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">Plan mode is not available for this runtime.</p>
            </div>
          )}
          {startError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">{startError}</p>
            </div>
          )}
          {voiceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">{voiceError}</p>
            </div>
          )}

        </div>
      </div>
      </div>
      {selectedArtifact && (
        <aside className="hidden min-h-0 min-w-[420px] flex-1 xl:block">
          <ArtifactViewer
            artifact={selectedArtifact}
            workspacePath={normalizedActiveWorkspacePath || workspacePath}
            onClose={() => setSelectedArtifact(null)}
          />
        </aside>
      )}
      {selectedAttachment && (
        <ImageAttachmentViewer
          attachment={selectedAttachment}
          onClose={() => setSelectedAttachment(null)}
        />
      )}
    </div>
  );
}
