import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ContextUsage,
  LiveChatMessage,
  LiveChatRun,
  LiveChatTimelineItem,
  TaskMessage,
  ToolProgressEvent,
} from '@shared/types';
import { apiAuthHeaders, fetchMessages, BASE } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import type { AgentRunSettings } from '../lib/api';
import { getSelectedOrganizationId } from '../lib/organization-selection';
import { getStoredAccessToken, hasAuthSessionCookie } from '../lib/auth-storage';
import { prepareAttachmentsForUpload } from '../lib/image-compression';

export type { ContextUsage, ToolProgressEvent };

type ChatMessage = Omit<TaskMessage, 'task_id'> & {
  task_id?: string;
  tools?: ToolProgressEvent[];
  timeline?: LiveChatTimelineItem[];
};

type LiveEvent =
  | { type: 'snapshot'; run: LiveChatRun }
  | { type: 'text_delta'; content?: string }
  | { type: 'thinking_delta'; content?: string }
  | {
      type: 'tool_progress';
      tool?: string;
      status?: ToolProgressEvent['status'];
      duration?: number;
      label?: string;
      details?: unknown;
    }
  | { type: 'done'; sessionId?: string; context?: ContextUsage | null }
  | { type: 'error'; error?: string };

const FINISHED_REFETCH_DELAY_MS = 700;

function compactSettings(settings?: AgentRunSettings): AgentRunSettings | undefined {
  if (!settings) return undefined;
  const compacted: AgentRunSettings = {};
  if (settings.runtime != null) compacted.runtime = settings.runtime;
  if (settings.model != null) compacted.model = settings.model;
  if (settings.reasoningEffort != null) compacted.reasoningEffort = settings.reasoningEffort;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function preserveLiveAssistantDetails(msgs: ChatMessage[], run?: LiveChatRun | null): ChatMessage[] {
  const liveAssistant = run ? findLastAssistant(run.messages) : undefined;
  if (!liveAssistant) return msgs;
  const liveTools = liveAssistant.tools;
  if (!liveAssistant.thinking && !liveTools?.length) return msgs;

  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue;

    const needsThinking = !!liveAssistant.thinking && !msgs[i].thinking;
    const needsTools = !!liveTools?.length && !msgs[i].tools?.length;
    const needsTimeline = !!liveAssistant.timeline?.length && !msgs[i].timeline?.length;
    if (!needsThinking && !needsTools && !needsTimeline) return msgs;

    const copy = msgs.slice();
    copy[i] = {
      ...copy[i],
      ...(needsThinking ? { thinking: liveAssistant.thinking } : {}),
      ...(needsTools ? { tools: liveTools.map((tool) => ({ ...tool })) } : {}),
      ...(needsTimeline ? { timeline: liveAssistant.timeline?.map(cloneTimelineItem) } : {}),
    };
    return copy;
  }

  return msgs;
}

function findLastAssistant(messages: LiveChatMessage[]): LiveChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
}

function ensureAssistant(run: LiveChatRun): LiveChatMessage {
  const existing = findLastAssistant(run.messages);
  if (existing) return existing;
  const msg: LiveChatMessage = {
    id: crypto.randomUUID(),
    task_id: run.taskId,
    role: 'assistant',
    content: '',
    created_at: Date.now(),
    timeline: [],
  };
  run.messages.push(msg);
  return msg;
}

function cloneTimelineItem(item: LiveChatTimelineItem): LiveChatTimelineItem {
  if (item.type === 'tool') return { ...item, tool: { ...item.tool } };
  return { ...item };
}

function mergeToolProgress(tools: ToolProgressEvent[], event: Extract<LiveEvent, { type: 'tool_progress' }>) {
  const tool: ToolProgressEvent = {
    tool: event.tool ?? 'tool',
    status: event.status ?? 'running',
    duration: event.duration,
    label: event.label,
    details: event.details,
  };

  if (tool.status === 'running') {
    const next = [...tools];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].tool === tool.tool && next[i].status === 'running' && next[i].label === tool.label) {
        next[i] = {
          ...next[i],
          ...tool,
          label: tool.label ?? next[i].label,
        };
        return next;
      }
    }
    return [...next, tool];
  }

  const next = [...tools];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].tool === tool.tool && next[i].status === 'running') {
      next[i] = {
        ...next[i],
        ...tool,
        label: tool.label ?? next[i].label,
      };
      return next;
    }
  }

  return [...next, tool];
}

function appendTextTimeline(assistant: LiveChatMessage, type: 'text' | 'thinking', content: string, now: number) {
  if (!assistant.timeline) assistant.timeline = [];
  const last = assistant.timeline[assistant.timeline.length - 1];
  if ((last?.type === 'text' || last?.type === 'thinking') && last.type === type && last.content.length < 1600) {
    last.content += content;
    return;
  }
  assistant.timeline.push({ id: crypto.randomUUID(), type, content, created_at: now });
}

function mergeToolTimeline(assistant: LiveChatMessage, event: Extract<LiveEvent, { type: 'tool_progress' }>, now: number) {
  if (!assistant.timeline) assistant.timeline = [];
  const tool: ToolProgressEvent = {
    tool: event.tool ?? 'tool',
    status: event.status ?? 'running',
    duration: event.duration,
    label: event.label,
    details: event.details,
  };

  for (let i = assistant.timeline.length - 1; i >= 0; i--) {
    const item = assistant.timeline[i];
    if (item.type !== 'tool' || item.tool.tool !== tool.tool) continue;
    if (tool.status === 'running' && item.tool.status === 'running' && item.tool.label === tool.label) {
      item.tool = { ...item.tool, ...tool, label: tool.label ?? item.tool.label };
      item.updated_at = now;
      return;
    }
    if (tool.status !== 'running' && item.tool.status === 'running') {
      item.tool = { ...item.tool, ...tool, label: tool.label ?? item.tool.label };
      item.updated_at = now;
      return;
    }
  }

  assistant.timeline.push({ id: crypto.randomUUID(), type: 'tool', tool, created_at: now, updated_at: now });
}

function appendErrorTimeline(assistant: LiveChatMessage, error: string, now: number) {
  if (!assistant.timeline) assistant.timeline = [];
  assistant.timeline.push({ id: crypto.randomUUID(), type: 'error', error, created_at: now });
}

function snapshotMessages(messages: LiveChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    tools: msg.tools ? msg.tools.map((t) => ({ ...t })) : undefined,
    timeline: msg.timeline ? msg.timeline.map(cloneTimelineItem) : undefined,
  }));
}

function liveMessagesFor(committed: ChatMessage[], run: LiveChatRun): ChatMessage[] {
  const live = snapshotMessages(run.messages);
  const firstLive = live[0];

  if (firstLive?.role === 'user' && committed.length > 0) {
    const lastMsg = committed[committed.length - 1];

    // Dedup case 1: committed ends with the same user message (normal pre-save overlap)
    if (lastMsg.role === 'user' && lastMsg.content === firstLive.content) {
      return live.slice(1);
    }

    // Dedup case 2: committed ends with [user, empty_assistant] — previous run left
    // an empty placeholder; the actual user message is the second-to-last entry
    if (lastMsg.role === 'assistant' && !lastMsg.content) {
      const secondLast = committed[committed.length - 2];
      if (secondLast?.role === 'user' && secondLast.content === firstLive.content) {
        return live.slice(1);
      }
    }
  }

  return live;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [activeTools, setActiveTools] = useState<ToolProgressEvent[]>([]);
  const [context, setContext] = useState<ContextUsage | null>(null);

  const postAbortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const committedMessagesRef = useRef<ChatMessage[]>([]);
  const liveRunRef = useRef<LiveChatRun | null>(null);
  const liveContextRef = useRef<ContextUsage | null>(null);
  const lastCommittedRunIdRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearRefetchTimer = useCallback(() => {
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
  }, []);

  const closeLiveSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    postAbortRef.current?.abort();
    postAbortRef.current = null;
    closeLiveSource();
    clearRefetchTimer();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [clearRefetchTimer, closeLiveSource]);

  const publishState = useCallback(() => {
    const committed = committedMessagesRef.current;
    const liveRun = liveRunRef.current;

    if (liveRun && liveRun.runId !== lastCommittedRunIdRef.current) {
      const merged = [...committed, ...liveMessagesFor(committed, liveRun)];
      const assistant = findLastAssistant(liveRun.messages);
      const streaming = liveRun.status === 'streaming';

      setMessages(merged);
      setIsStreaming(streaming);
      setThinkingContent(streaming ? assistant?.thinking ?? '' : '');
      setActiveTools(streaming ? assistant?.tools?.map((t) => ({ ...t })) ?? [] : []);
      setContext(liveRun.context !== undefined ? liveRun.context : liveContextRef.current);
      return;
    }

    setMessages(committed);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(liveContextRef.current);
  }, []);

  const schedulePublish = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      publishState();
    });
  }, [publishState]);

  const refreshCommittedMessages = useCallback(async (taskId: string, finishedRunId?: string) => {
    if (taskIdRef.current !== taskId) return;
    try {
      const { messages: msgs, context: persistedContext } = await fetchMessages(taskId);
      if (taskIdRef.current !== taskId) return;

      const finishedLiveRun = finishedRunId && liveRunRef.current?.runId === finishedRunId
        ? liveRunRef.current
        : null;
      committedMessagesRef.current = preserveLiveAssistantDetails(msgs as ChatMessage[], finishedLiveRun);
      liveContextRef.current = persistedContext ?? liveContextRef.current;

      if (finishedRunId) {
        lastCommittedRunIdRef.current = finishedRunId;
        if (liveRunRef.current?.runId === finishedRunId) liveRunRef.current = null;
      }

      publishState();
    } catch (err) {
      console.warn('Failed to refresh committed messages:', err);
    }
  }, [publishState]);

  const scheduleFinishedRefresh = useCallback((taskId: string, runId: string) => {
    clearRefetchTimer();
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      void refreshCommittedMessages(taskId, runId);
    }, FINISHED_REFETCH_DELAY_MS);
  }, [clearRefetchTimer, refreshCommittedMessages]);

  const applySnapshot = useCallback((run: LiveChatRun) => {
    if (taskIdRef.current && taskIdRef.current !== run.taskId) return;
    taskIdRef.current = run.taskId;

    if (run.status === 'done' && run.runId === lastCommittedRunIdRef.current) {
      if (liveRunRef.current?.runId === run.runId) liveRunRef.current = null;
      publishState();
      return;
    }

    liveRunRef.current = run;
    if (run.context !== undefined) liveContextRef.current = run.context;
    publishState();

    if (run.status === 'done') scheduleFinishedRefresh(run.taskId, run.runId);
  }, [publishState, scheduleFinishedRefresh]);

  const applyLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type === 'snapshot') {
      applySnapshot(event.run);
      return;
    }

    const run = liveRunRef.current;
    if (!run) return;

    if (event.type === 'text_delta' && event.content) {
      const now = Date.now();
      const assistant = ensureAssistant(run);
      assistant.content += event.content;
      appendTextTimeline(assistant, 'text', event.content, now);
      run.updatedAt = now;
      schedulePublish();
      return;
    }

    if (event.type === 'thinking_delta' && event.content) {
      const now = Date.now();
      const assistant = ensureAssistant(run);
      assistant.thinking = (assistant.thinking ?? '') + event.content;
      appendTextTimeline(assistant, 'thinking', event.content, now);
      run.updatedAt = now;
      schedulePublish();
      return;
    }

    if (event.type === 'tool_progress') {
      const now = Date.now();
      const assistant = ensureAssistant(run);
      assistant.tools = mergeToolProgress(assistant.tools ?? [], event);
      mergeToolTimeline(assistant, event, now);
      run.updatedAt = now;
      schedulePublish();
      return;
    }

    if (event.type === 'error') {
      const error = event.error || 'Unknown error';
      run.status = 'error';
      run.error = error;
      const assistant = ensureAssistant(run);
      if (!assistant.content.includes(`[Error: ${error}]`)) {
        assistant.content = assistant.content
          ? `${assistant.content}\n[Error: ${error}]`
          : `[Error: ${error}]`;
      }
      const now = Date.now();
      appendErrorTimeline(assistant, error, now);
      run.updatedAt = now;
      publishState();
      return;
    }

    if (event.type === 'done') {
      if (event.sessionId) run.sessionId = event.sessionId;
      if (run.status !== 'error') run.status = 'done';
      if (event.context !== undefined) {
        run.context = event.context;
        liveContextRef.current = event.context;
      }
      run.updatedAt = Date.now();
      publishState();

      if (run.status === 'done') {
        scheduleFinishedRefresh(run.taskId, run.runId);
      }
    }
  }, [applySnapshot, publishState, scheduleFinishedRefresh, schedulePublish]);

  const openLiveSubscription = useCallback((taskId: string) => {
    const existing = sourceRef.current;
    if (
      existing &&
      taskIdRef.current === taskId &&
      existing.readyState !== EventSource.CLOSED
    ) {
      return;
    }

    closeLiveSource();
    taskIdRef.current = taskId;

    const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
    const accessToken = getStoredAccessToken();
    const params = new URLSearchParams();
    if (organizationId) params.set('organizationId', organizationId);
    if (accessToken) params.set('accessToken', accessToken);
    const query = params.toString();
    const source = new EventSource(`${BASE}/tasks/${encodeURIComponent(taskId)}/live${query ? `?${query}` : ''}`);
    source.onmessage = (message) => {
      if (taskIdRef.current !== taskId) return;
      try {
        applyLiveEvent(JSON.parse(message.data) as LiveEvent);
      } catch (err) {
        console.warn('Failed to parse live chat event:', message.data, err);
      }
    };
    source.onerror = () => {};
    sourceRef.current = source;
  }, [applyLiveEvent, closeLiveSource]);

  const clearAllState = useCallback(() => {
    teardown();
    taskIdRef.current = null;
    committedMessagesRef.current = [];
    liveRunRef.current = null;
    liveContextRef.current = null;
    lastCommittedRunIdRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(null);
  }, [teardown]);

  const loadMessages = useCallback(async (taskId: string) => {
    clearAllState();
    taskIdRef.current = taskId;

    const { messages: msgs, context: persistedContext } = await fetchMessages(taskId);
    if (taskIdRef.current !== taskId) return msgs;

    committedMessagesRef.current = msgs as ChatMessage[];
    liveContextRef.current = persistedContext ?? null;
    publishState();
    openLiveSubscription(taskId);
    return msgs;
  }, [clearAllState, openLiveSubscription, publishState]);

  const appendLocalSendError = useCallback((content: string, error: string) => {
    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content, created_at: now },
      { id: crypto.randomUUID(), role: 'assistant', content: `[Error: ${error}]`, created_at: now },
    ]);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
  }, []);

  const sendMessage = useCallback(async (taskId: string, content: string, settings?: AgentRunSettings, attachments?: File[]) => {
    openLiveSubscription(taskId);

    const abort = new AbortController();
    postAbortRef.current = abort;
    const runSettings = compactSettings(settings);
    const hasAttachments = Boolean(attachments?.length);

    try {
      const preparedAttachments = attachments?.length
        ? await prepareAttachmentsForUpload(attachments)
        : [];
      const body = hasAttachments ? new FormData() : JSON.stringify({
        content,
        ...(runSettings ? { settings: runSettings } : {}),
      });
      const headers: HeadersInit = hasAttachments ? apiAuthHeaders() : { 'Content-Type': 'application/json', ...apiAuthHeaders() };

      if (body instanceof FormData) {
        body.append('content', content);
        if (runSettings?.runtime) body.append('runtime', runSettings.runtime);
        if (runSettings?.model) body.append('model', runSettings.model);
        if (runSettings?.reasoningEffort) body.append('reasoningEffort', runSettings.reasoningEffort);
        for (const attachment of preparedAttachments) {
          body.append('attachments', attachment, attachment.name);
        }
      }

      const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/messages`, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
      });

      const responseBody = await res.json().catch(() => ({})) as { run?: LiveChatRun; error?: string };

      if (!res.ok) {
        if (res.status !== 409) appendLocalSendError(content, responseBody.error || `HTTP ${res.status}`);
        return;
      }

      if (responseBody.run) applySnapshot(responseBody.run);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        appendLocalSendError(content, toErrorMessage(err, 'Failed to send message.'));
      }
    } finally {
      if (postAbortRef.current === abort) postAbortRef.current = null;
    }
  }, [appendLocalSendError, applySnapshot, openLiveSubscription]);

  useEffect(() => () => {
    teardown();
  }, [teardown]);

  return { messages, isStreaming, thinkingContent, activeTools, context, sendMessage, loadMessages, reset: clearAllState };
}
