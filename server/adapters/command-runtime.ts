import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ActivityIntentDecision, AgentModelsResponse, AgentModelOption, AgentRuntime, ContextUsage, ReasoningEffort, SessionMetadata, TaskMessage } from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';
import { resolveBeesWorkspaceDir } from '../paths.js';
import { ACTIVITY_INTENT_SYSTEM_PROMPT, buildActivityIntentRequest, normalizeActivityIntentDecision } from '../prompts/activity-intent.js';

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) waiters.shift()?.resolve({ value: undefined as T, done: true });
    },
    fail(error: Error) {
      failure = error;
      while (waiters.length > 0) waiters.shift()?.reject(error);
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false });
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
      };
    },
  };
}

async function writeTaskFiles(runtime: AgentRuntime, sessionId: string, message: string, options?: AgentRunOptions) {
  const dir = join(tmpdir(), 'bees-runtime-prompts', runtime, sessionId);
  await mkdir(dir, { recursive: true });

  const promptFile = join(dir, 'prompt.txt');
  const contextFile = join(dir, 'task-context.json');
  const payload = {
    runtime,
    sessionId,
    message,
    systemMessage: options?.systemMessage ?? null,
    task: {
      id: options?.task?.id ?? sessionId,
      title: options?.task?.title ?? null,
      workspacePath: options?.task?.workspacePath ?? null,
    },
    settings: options?.settings ?? {},
  };

  await writeFile(promptFile, `${options?.systemMessage ? `${options.systemMessage}\n\n` : ''}${message}`, 'utf8');
  await writeFile(contextFile, JSON.stringify(payload, null, 2), 'utf8');
  return { dir, promptFile, contextFile };
}

function parseCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (char === '\\' && quote === '"' && command[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\u0007|\x1B\\))/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function appendTail(current: string, next: string, maxLength = 8000): string {
  const combined = `${current}${next}`;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

function filterBenignRuntimeStderr(runtime: Exclude<AgentRuntime, 'hermes'>, text: string): string {
  if (runtime !== 'codex') return text;

  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return true;
      if (/WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell/i.test(line)) return false;
      if (/WARN codex_core_skills::loader: ignoring interface\.icon_(?:small|large): icon path must not contain '\.\.'/i.test(line)) return false;
      return true;
    })
    .join('\n');
}

function envSeconds(name: string): number | null | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function commandTimeoutMs(runtime: Exclude<AgentRuntime, 'hermes'>): number | null {
  const runtimeKey = runtime.toUpperCase();
  // claude_code tasks can run for hours — only respect an explicit per-runtime override, never the global fallback
  const configured = envSeconds(`BEES_${runtimeKey}_TIMEOUT_SECONDS`);
  if (runtime === 'claude_code') return configured != null && configured > 0 ? configured * 1000 : null;
  const globalConfigured = configured ?? envSeconds('BEES_COMMAND_RUNTIME_TIMEOUT_SECONDS');
  if (globalConfigured != null) return globalConfigured > 0 ? globalConfigured * 1000 : null;
  return null;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Response did not contain a JSON object.');
  }
}

function executableStem(executable: string): string {
  return basename(executable).toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/i, '');
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || (flag.startsWith('--') && arg.startsWith(`${flag}=`))));
}

function flagValue(args: string[], flag: string): string | null {
  const inline = args.find((arg) => flag.startsWith('--') && arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.findIndex((arg) => arg === flag);
  if (index < 0) return null;
  return args[index + 1] && !args[index + 1].startsWith('-') ? args[index + 1] : null;
}

function pathEnvValue(): string {
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path');
  return entry?.[1] ?? '';
}

function pathextValues(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1';
  return raw.split(';').map((item) => item.trim()).filter(Boolean);
}

function resolveWindowsExecutable(command: string): string {
  const candidates: string[] = [];
  const hasExtension = /\.[^./\\]+$/.test(command);
  const extensions = hasExtension ? [''] : pathextValues();

  if (command.includes('/') || command.includes('\\')) {
    const base = isAbsolute(command) ? command : resolve(process.cwd(), command);
    for (const extension of extensions) {
      candidates.push(`${base}${extension}`);
    }
  } else {
    const dirs = pathEnvValue().split(';').map((entry) => entry.trim()).filter(Boolean);
    for (const dir of dirs) {
      for (const extension of extensions) {
        candidates.push(join(dir, `${command}${extension}`));
      }
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? command;
}

function resolveExecutable(command: string): string {
  if (process.platform === 'win32') return resolveWindowsExecutable(command);
  if (command.includes('/') || command.includes('\\')) return isAbsolute(command) ? command : resolve(process.cwd(), command);
  return command;
}

// Map app ReasoningEffort values to Codex model_reasoning_effort config values.
function toCodexReasoningEffort(effort: string): string | null {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'high-v2';
    default: return null;
  }
}

function applyCodexDefaults(args: string[], options?: AgentRunOptions): string[] {
  const normalized = args[0] === 'exec' ? args.slice(1) : args.slice();
  const next: string[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === '--ask-for-approval') {
      if (normalized[index + 1] && !normalized[index + 1].startsWith('-')) index += 1;
      continue;
    }
    next.push(arg);
  }

  if (!hasFlag(next, '-m', '--model') && options?.settings?.model) {
    next.push('-m', options.settings.model);
  }
  // Pass reasoning effort via -c config override if not already set.
  const effortValue = options?.settings?.reasoningEffort
    ? toCodexReasoningEffort(options.settings.reasoningEffort)
    : null;
  if (effortValue && !next.some((arg) => arg.startsWith('model_reasoning_effort'))) {
    next.push('-c', `model_reasoning_effort="${effortValue}"`);
  }
  if (!hasFlag(next, '-s', '--sandbox') && !hasFlag(next, '--dangerously-bypass-approvals-and-sandbox')) {
    // Codex's OS-level sandbox on Windows shells out via CreateProcessAsUserW, which is
    // denied under this server's execution context (fails every tool call with error 5).
    // Skip the sandbox there; workspace-write is safe to use on other platforms.
    if (process.platform === 'win32') next.push('--dangerously-bypass-approvals-and-sandbox');
    else next.push('--sandbox', 'workspace-write');
  }
  if (!hasFlag(next, '--skip-git-repo-check')) next.push('--skip-git-repo-check');
  if (!hasFlag(next, '--json')) next.push('--json');
  if (!hasFlag(next, '--color')) next.push('--color', 'never');
  if (!next.includes('-')) next.push('-');

  return ['exec', ...next];
}

function applyClaudeDefaults(args: string[], options?: AgentRunOptions): string[] {
  const next = args.slice();
  if (!hasFlag(next, '-p', '--print')) next.push('-p');
  if (!hasFlag(next, '--output-format')) next.push('--output-format', 'stream-json');
  if (flagValue(next, '--output-format') === 'stream-json' && !hasFlag(next, '--verbose')) {
    next.push('--verbose');
  }
  if (!hasFlag(next, '--include-partial-messages')) next.push('--include-partial-messages');
  if (!hasFlag(next, '--dangerously-skip-permissions', '--permission-mode')) {
    next.push('--dangerously-skip-permissions');
  }
  if (!hasFlag(next, '--model') && options?.settings?.model) {
    next.push('--model', options.settings.model);
  }
  if (!hasFlag(next, '--effort') && options?.settings?.reasoningEffort) {
    next.push('--effort', options.settings.reasoningEffort);
  }
  return next;
}

function applyOpenCodeDefaults(args: string[], options?: AgentRunOptions): string[] {
  const normalized = args[0] === 'run' ? args.slice(1) : args.slice();
  const next = ['run', ...normalized];
  if (!hasFlag(next, '--pure')) next.push('--pure');
  if (!hasFlag(next, '--format')) next.push('--format', 'default');
  if (!hasFlag(next, '--dangerously-skip-permissions')) {
    next.push('--dangerously-skip-permissions');
  }
  if (!hasFlag(next, '-m', '--model') && options?.settings?.model) {
    next.push('--model', options.settings.model);
  }
  return next;
}

function prepareCommand(
  runtime: Exclude<AgentRuntime, 'hermes'>,
  command: string,
  options?: AgentRunOptions,
): { executable: string; args: string[]; label: string } {
  const tokens = parseCommandLine(command.trim());
  if (tokens.length === 0) return { executable: '', args: [], label: '' };

  const executable = resolveExecutable(tokens[0]);
  const stem = executableStem(executable);
  let args = tokens.slice(1);

  if (runtime === 'codex' && stem === 'codex') args = applyCodexDefaults(args, options);
  if (runtime === 'claude_code') args = applyClaudeDefaults(args, options);
  if (runtime === 'opencode' && stem === 'opencode') args = applyOpenCodeDefaults(args, options);

  return {
    executable,
    args,
    label: [executable, ...args].join(' '),
  };
}

interface RuntimeStreamState {
  runtime: Exclude<AgentRuntime, 'hermes'>;
  parseStructured: boolean;
  buffer: string;
  stdoutTail: string;
  sawStructured: boolean;
  textSnapshots: Map<string, string>;
  thinkingSnapshots: Map<string, string>;
  runningTools: Set<string>;
  pendingTextDrains: Promise<void>[];
  context: ContextUsage | null;
}

function shouldParseStructuredOutput(runtime: Exclude<AgentRuntime, 'hermes'>, args: string[]): boolean {
  if (runtime === 'codex') return hasFlag(args, '--json');
  if (runtime === 'claude_code') {
    return flagValue(args, '--output-format') === 'stream-json';
  }
  if (runtime === 'opencode') {
    const index = args.findIndex((arg) => arg === '--format');
    return index >= 0 && /json/i.test(args[index + 1] ?? '');
  }
  return false;
}

function textFromContentParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContentParts).join('');
  if (!isRecord(value)) return '';

  for (const key of ['text', 'delta', 'content', 'output', 'result']) {
    const text = value[key];
    if (typeof text === 'string') return text;
  }

  return '';
}

function codexItemKey(item: Record<string, unknown>, fallback: string): string {
  return stringValue(item.id) ?? stringValue(item.call_id) ?? stringValue(item.name) ?? fallback;
}

function itemText(item: Record<string, unknown>): string {
  return textFromContentParts(item.content ?? item.text ?? item.delta ?? item.output);
}

function itemThinking(item: Record<string, unknown>): string {
  return textFromContentParts(item.summary ?? item.reasoning ?? item.content ?? item.text);
}

function emitSnapshotDelta(
  state: RuntimeStreamState,
  channel: 'text_delta' | 'thinking_delta',
  key: string,
  text: string,
  events: StreamEvent[],
): void {
  if (!text) return;
  const snapshots = channel === 'text_delta' ? state.textSnapshots : state.thinkingSnapshots;
  const previous = snapshots.get(key) ?? '';
  const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
  snapshots.set(key, text);
  if (delta) events.push({ type: channel, content: delta });
}

function toolLabelFromItem(item: Record<string, unknown>): string | undefined {
  const command = item.command ?? item.cmd ?? item.input;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map((part) => String(part)).join(' ');
  if (isRecord(command)) {
    const commandText = stringValue(command.command) ?? stringValue(command.cmd);
    if (commandText) return commandText;
  }
  return stringValue(item.name) ?? stringValue(item.type) ?? undefined;
}

function toolNameFromItem(item: Record<string, unknown>): string {
  return stringValue(item.name) ?? stringValue(item.tool_name) ?? stringValue(item.type) ?? 'tool';
}

function emitToolProgress(
  state: RuntimeStreamState,
  key: string,
  event: StreamEvent,
  events: StreamEvent[],
): void {
  if (event.status === 'running') {
    if (state.runningTools.has(key)) return;
    state.runningTools.add(key);
  } else {
    state.runningTools.delete(key);
  }
  events.push(event);
}

function contextFromUsage(usage: unknown): ContextUsage | null {
  if (!isRecord(usage)) return null;
  const used = numberValue(usage.used_tokens)
    ?? numberValue(usage.total_tokens)
    ?? numberValue(usage.input_tokens)
    ?? numberValue(usage.inputTokens);
  const window = numberValue(usage.window_tokens)
    ?? numberValue(usage.context_window)
    ?? numberValue(usage.contextWindowTokens);
  if (used == null || window == null) return null;
  return { used_tokens: used, window_tokens: window };
}

function codexPayload(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.payload) ? record.payload : record;
}

function normalizeCodexEvent(record: Record<string, unknown>, state: RuntimeStreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const payload = codexPayload(record);
  const type = stringValue(payload.type) ?? stringValue(record.type) ?? '';
  const item = isRecord(payload.item) ? payload.item : isRecord(payload.message) ? payload.message : null;
  const itemType = item ? stringValue(item.type) ?? '' : '';

  const directText = stringValue(payload.delta)
    ?? stringValue(payload.text)
    ?? stringValue(payload.content)
    ?? stringValue(payload.message);
  if (directText && /(agent_message|assistant|message|output_text|text_delta|text\.delta|response\.output_text)/i.test(type)) {
    events.push({ type: 'text_delta', content: directText });
    return events;
  }

  if (directText && /(reasoning|thought|thinking)/i.test(type)) {
    events.push({ type: 'thinking_delta', content: directText });
    return events;
  }

  if (item) {
    const key = codexItemKey(item, type || 'codex-item');
    const isAssistantMessage = itemType === 'message'
      || itemType === 'agent_message'
      || itemType === 'assistant_message'
      || itemType === 'output_text';
    const isReasoning = /reasoning|thought|thinking/i.test(itemType);
    const isTool = /tool|function|shell|command|exec/i.test(itemType);

    if (isAssistantMessage) {
      emitSnapshotDelta(state, 'text_delta', key, itemText(item), events);
    } else if (isReasoning) {
      emitSnapshotDelta(state, 'thinking_delta', key, itemThinking(item), events);
    }

    if (isTool && /started|in_progress|pending/i.test(type)) {
      emitToolProgress(state, key, {
        type: 'tool_progress',
        tool: toolNameFromItem(item),
        status: 'running',
        label: toolLabelFromItem(item),
        details: item,
      }, events);
    } else if (isTool && /completed|done|finished/i.test(type)) {
      emitToolProgress(state, key, {
        type: 'tool_progress',
        tool: toolNameFromItem(item),
        status: 'completed',
        label: toolLabelFromItem(item),
        details: item,
      }, events);
    } else if (isTool && /error|failed/i.test(type)) {
      emitToolProgress(state, key, {
        type: 'tool_progress',
        tool: toolNameFromItem(item),
        status: 'error',
        label: toolLabelFromItem(item),
        details: item,
      }, events);
    }
  }

  if (/turn\.(completed|done)|response\.completed/i.test(type)) {
    state.context = contextFromUsage(payload.usage) ?? state.context;
  }

  if (/task_complete/i.test(type)) {
    const lastMessage = stringValue(payload.last_agent_message);
    const alreadyEmitted = lastMessage
      ? Array.from(state.textSnapshots.values()).includes(lastMessage)
      : false;
    if (lastMessage && !alreadyEmitted) {
      emitSnapshotDelta(state, 'text_delta', 'codex-task-complete', lastMessage, events);
    }
  }

  if (/error/i.test(type)) {
    const error = stringValue(payload.message) ?? stringValue(payload.error);
    if (error) events.push({ type: 'error', error, code: 'runtime_stream_error' });
  }

  return events;
}

function normalizeClaudeEvent(record: Record<string, unknown>, state: RuntimeStreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const type = stringValue(record.type) ?? '';

  if (type === 'assistant' && isRecord(record.message)) {
    const content = Array.isArray(record.message.content) ? record.message.content : [];
    let text = '';
    let thinking = '';

    for (const part of content) {
      if (!isRecord(part)) continue;
      const partType = stringValue(part.type) ?? '';
      if (partType === 'text') text += stringValue(part.text) ?? '';
      if (/thinking|reasoning/i.test(partType)) thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? '';
      if (partType === 'tool_use') {
        const key = stringValue(part.id) ?? stringValue(part.name) ?? 'claude-tool';
        emitToolProgress(state, key, {
          type: 'tool_progress',
          tool: stringValue(part.name) ?? 'tool',
          status: 'running',
          label: stringValue(part.name) ?? undefined,
          details: part.input,
        }, events);
      }
    }

    emitSnapshotDelta(state, 'text_delta', 'claude-assistant', text, events);
    emitSnapshotDelta(state, 'thinking_delta', 'claude-thinking', thinking, events);
  }

  if (type === 'user' && isRecord(record.message)) {
    const content = Array.isArray(record.message.content) ? record.message.content : [];
    for (const part of content) {
      if (!isRecord(part) || stringValue(part.type) !== 'tool_result') continue;
      const key = stringValue(part.tool_use_id) ?? 'claude-tool';
      emitToolProgress(state, key, {
        type: 'tool_progress',
        tool: key,
        status: part.is_error === true ? 'error' : 'completed',
      }, events);
    }
  }

  if (type === 'result') {
    const result = stringValue(record.result);
    if (result && state.textSnapshots.size === 0) {
      emitSnapshotDelta(state, 'text_delta', 'claude-result', result, events);
    }
    if (record.is_error === true) {
      events.push({
        type: 'error',
        error: result || stringValue(record.message) || 'Claude Code returned an error',
        code: 'runtime_stream_error',
      });
    }
  }

  return events;
}

function normalizeGenericJsonEvent(record: Record<string, unknown>, state: RuntimeStreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const type = stringValue(record.type) ?? stringValue(record.event) ?? '';
  const text = stringValue(record.delta)
    ?? stringValue(record.text)
    ?? stringValue(record.content)
    ?? (isRecord(record.message) ? textFromContentParts(record.message.content ?? record.message.text) : null);

  if (text && /thinking|reasoning|thought/i.test(type)) {
    events.push({ type: 'thinking_delta', content: text });
  } else if (text && /message|assistant|text|delta|content|output/i.test(type)) {
    events.push({ type: 'text_delta', content: text });
  }

  const tool = stringValue(record.tool) ?? stringValue(record.name) ?? stringValue(record.tool_name);
  if (tool && /tool|command|exec|shell/i.test(type)) {
    const status = /error|fail/i.test(type) ? 'error' : /complete|done|finish|end/i.test(type) ? 'completed' : 'running';
    emitToolProgress(state, `${tool}:${stringValue(record.id) ?? ''}`, {
      type: 'tool_progress',
      tool,
      status,
      label: stringValue(record.label) ?? tool,
      details: record.details ?? record.input ?? record.output,
    }, events);
  }

  const error = stringValue(record.error) ?? stringValue(record.message);
  if (error && /error|fail/i.test(type)) {
    events.push({ type: 'error', error, code: 'runtime_stream_error' });
  }

  state.context = contextFromUsage(record.usage) ?? state.context;
  return events;
}

function normalizeStructuredEvent(record: Record<string, unknown>, state: RuntimeStreamState): StreamEvent[] {
  if (state.runtime === 'codex') return normalizeCodexEvent(record, state);
  if (state.runtime === 'claude_code') return normalizeClaudeEvent(record, state);
  return normalizeGenericJsonEvent(record, state);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function splitTextForDrip(text: string): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const token of text.match(/\S+\s*|\s+/g) ?? [text]) {
    current += token;
    if (current.length >= 56 || /\n$/.test(current)) {
      chunks.push(current);
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function pushStreamEvent(
  state: RuntimeStreamState,
  queue: ReturnType<typeof createAsyncQueue<StreamEvent>>,
  event: StreamEvent,
): void {
  if (
    state.runtime !== 'codex' ||
    event.type !== 'text_delta' ||
    !event.content ||
    event.content.length < 120
  ) {
    queue.push(event);
    return;
  }

  const chunks = splitTextForDrip(event.content);
  const drain = (async () => {
    for (const chunk of chunks) {
      queue.push({ ...event, content: chunk });
      await delay(18);
    }
  })();
  state.pendingTextDrains.push(drain);
}

async function waitForPendingText(state: RuntimeStreamState): Promise<void> {
  while (state.pendingTextDrains.length > 0) {
    const drains = state.pendingTextDrains.splice(0);
    await Promise.allSettled(drains);
  }
}

function handleStructuredLine(line: string, state: RuntimeStreamState, queue: ReturnType<typeof createAsyncQueue<StreamEvent>>): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (!state.sawStructured) queue.push({ type: 'text_delta', content: `${line}\n` });
    return;
  }

  if (!isRecord(parsed)) return;
  state.sawStructured = true;
  for (const event of normalizeStructuredEvent(parsed, state)) pushStreamEvent(state, queue, event);
}

function handleStdoutChunk(
  chunk: unknown,
  state: RuntimeStreamState,
  queue: ReturnType<typeof createAsyncQueue<StreamEvent>>,
): void {
  const text = stripAnsi(String(chunk));
  if (!text) return;
  state.stdoutTail = appendTail(state.stdoutTail, text);

  if (!state.parseStructured) {
    queue.push({ type: 'text_delta', content: text });
    return;
  }

  state.buffer += text;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? '';
  for (const line of lines) handleStructuredLine(line, state, queue);
}

function flushStdout(state: RuntimeStreamState, queue: ReturnType<typeof createAsyncQueue<StreamEvent>>): void {
  if (!state.buffer) return;
  handleStructuredLine(state.buffer, state, queue);
  state.buffer = '';
}

function processDetails(
  prepared: { executable: string; args: string[]; label: string },
  cwd: string,
  startedAt: number,
  files: { promptFile: string; contextFile: string },
  stdoutTail: string,
  stderrTail: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command: prepared.label,
    executable: prepared.executable,
    args: prepared.args,
    cwd,
    promptFile: files.promptFile,
    contextFile: files.contextFile,
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    stdoutTail,
    stderrTail,
    ...extra,
  };
}

function pushProcessUpdate(
  queue: ReturnType<typeof createAsyncQueue<StreamEvent>>,
  prepared: { executable: string; args: string[]; label: string },
  cwd: string,
  startedAt: number,
  files: { promptFile: string; contextFile: string },
  stdoutTail: string,
  stderrTail: string,
  extra: Record<string, unknown> = {},
): void {
  queue.push({
    type: 'tool_progress',
    tool: 'process',
    status: 'running',
    label: prepared.label,
    details: processDetails(prepared, cwd, startedAt, files, stdoutTail, stderrTail, extra),
  });
}

function mergeModelOptions(values: Array<{ id: string; label?: string; source?: AgentModelOption['source']; isCurrentDefault?: boolean }>): AgentModelOption[] {
  const seen = new Set<string>();
  const options: AgentModelOption[] = [];

  for (const entry of values) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: entry.label?.trim() || id,
      source: entry.source ?? 'catalog',
      isCurrentDefault: entry.isCurrentDefault,
    });
  }

  return options;
}

function parseTomlStringValue(line: string): string | null {
  const match = line.match(/=\s*"([^"]+)"/);
  return match?.[1]?.trim() || null;
}

async function discoverCodexModels(command: string): Promise<AgentModelsResponse> {
  // Step 1: Read default model from ~/.codex/config.toml
  const configPath = join(homedir(), '.codex', 'config.toml');
  let defaultModel: string | null = null;
  try {
    const content = await readFile(configPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^\[/.test(trimmed)) break; // stop at first section
      if (trimmed.startsWith('model')) {
        defaultModel = parseTomlStringValue(trimmed) ?? defaultModel;
        break;
      }
    }
  } catch {
    // Best-effort only.
  }

  // Step 2: Run `codex debug models` to get the live catalog
  const tokens = parseCommandLine(command.trim());
  const executable = tokens.length > 0 ? resolveExecutable(tokens[0]) : 'codex';
  if (executableStem(executable) !== 'codex') {
    const fallback = mergeModelOptions(
      defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : [],
    );
    return { runtime: 'codex', defaultModel, activeProvider: 'openai', groups: fallback.length > 0 ? [{ provider: 'Codex', models: fallback }] : [] };
  }

  try {
    const result = await runProcessCapture(
      executable,
      ['debug', 'models'],
      { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      resolveBeesWorkspaceDir(),
    );

    if (result.code === 0 && result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout.trim()) as {
        models: Array<{ slug: string; display_name?: string; visibility?: string }>;
      };

      const catalogModels = (parsed.models ?? [])
        .filter((m) => m.slug && m.visibility !== 'hide')
        .map((m) => ({
          id: m.slug,
          label: m.display_name?.trim() || m.slug,
          source: 'catalog' as const,
          isCurrentDefault: m.slug === defaultModel,
        }));

      const models = mergeModelOptions([
        ...(defaultModel && !catalogModels.some((m) => m.id === defaultModel)
          ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }]
          : []),
        ...catalogModels,
      ]);

      return {
        runtime: 'codex',
        defaultModel,
        activeProvider: 'openai',
        groups: models.length > 0 ? [{ provider: 'OpenAI (Codex)', models }] : [],
      };
    }
  } catch {
    // Fall through to static fallback.
  }

  // Step 3: Static fallback
  const fallbackModels = mergeModelOptions([
    ...(defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : []),
    { id: 'gpt-5.5', label: 'GPT-5.5', source: 'catalog' as const },
    { id: 'gpt-5.4', label: 'GPT-5.4', source: 'catalog' as const },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', source: 'catalog' as const }
  ]);

  return {
    runtime: 'codex',
    defaultModel,
    activeProvider: 'openai',
    groups: fallbackModels.length > 0 ? [{ provider: 'OpenAI (Codex)', models: fallbackModels }] : [],
  };
}

async function discoverClaudeModels(): Promise<AgentModelsResponse> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let defaultModel: string | null = null;
  let providerLabel = 'Claude Code';

  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    if (typeof parsed.env?.ANTHROPIC_MODEL === 'string' && parsed.env.ANTHROPIC_MODEL.trim()) {
      defaultModel = parsed.env.ANTHROPIC_MODEL.trim();
    }
    if (typeof parsed.env?.ANTHROPIC_BASE_URL === 'string' && parsed.env.ANTHROPIC_BASE_URL.trim()) {
      providerLabel = 'Claude Code Provider';
    }
  } catch {
    // Best-effort discovery only.
  }

  const models = mergeModelOptions([
    ...(defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : []),
    { id: 'sonnet', label: 'sonnet', source: 'alias' },
    { id: 'opus', label: 'opus', source: 'alias' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', source: 'alias' },
  ]);

  return {
    runtime: 'claude_code',
    defaultModel,
    activeProvider: 'anthropic',
    groups: models.length > 0 ? [{ provider: providerLabel, models }] : [],
  };
}

async function runProcessCapture(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += stripAnsi(String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr += stripAnsi(String(chunk)); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ stdout, stderr, code }));
  });
}

async function discoverOpenCodeModels(command: string): Promise<AgentModelsResponse> {
  const tokens = parseCommandLine(command.trim());
  const executable = tokens.length > 0 ? resolveExecutable(tokens[0]) : 'opencode';
  if (executableStem(executable) !== 'opencode') {
    return { runtime: 'opencode', defaultModel: null, activeProvider: 'opencode', groups: [] };
  }

  const dir = join(tmpdir(), 'bees-runtime-models', 'opencode', randomUUID());
  const xdgConfigHome = join(dir, 'config');
  const xdgDataHome = join(dir, 'data');
  await mkdir(xdgConfigHome, { recursive: true });
  await mkdir(xdgDataHome, { recursive: true });

  try {
    const result = await runProcessCapture(
      executable,
      ['models'],
      {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
      },
      resolveBeesWorkspaceDir(),
    );

    if (result.code !== 0) {
      return { runtime: 'opencode', defaultModel: null, activeProvider: 'opencode', groups: [] };
    }

    const grouped = new Map<string, AgentModelOption[]>();
    for (const line of result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const [provider, ...rest] = line.split('/');
      const id = rest.join('/').trim();
      if (!provider || !id) continue;
      const models = grouped.get(provider) ?? [];
      models.push({ id: line, label: id, source: 'catalog' });
      grouped.set(provider, models);
    }

    return {
      runtime: 'opencode',
      defaultModel: null,
      activeProvider: grouped.keys().next().value ?? 'opencode',
      groups: [...grouped.entries()].map(([provider, models]) => ({ provider, models })),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class CommandRuntimeAdapter implements AgentAdapter {
  constructor(
    private readonly runtime: Exclude<AgentRuntime, 'hermes'>,
    private readonly command: string,
  ) {}

  async chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }> {
    let text = '';
    let error: string | null = null;
    for await (const event of this.chatStream(sessionId, message, options)) {
      if (event.type === 'text_delta') text += event.content ?? '';
      if (event.type === 'error') error = event.error ?? 'Command runtime failed';
    }
    if (error) throw new Error(error);
    return { text, sessionId };
  }

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    if (!this.command.trim()) {
      yield {
        type: 'error',
        error: `${this.runtime} runtime is not configured. Set the corresponding BEES_*_COMMAND environment variable.`,
        code: 'runtime_not_configured',
      };
      yield { type: 'done', sessionId };
      return;
    }

    const queue = createAsyncQueue<StreamEvent>();
    const cwd = options?.task?.workspacePath ?? resolveBeesWorkspaceDir();
    const startedAt = Date.now();

    void (async () => {
      const files = await writeTaskFiles(this.runtime, sessionId, message, options);
      const promptText = await readFile(files.promptFile, 'utf8');
      const xdgConfigHome = join(files.dir, 'xdg-config');
      const xdgDataHome = join(files.dir, 'xdg-data');
      await mkdir(xdgConfigHome, { recursive: true });
      await mkdir(xdgDataHome, { recursive: true });
      const prepared = prepareCommand(this.runtime, this.command, options);
      const streamState: RuntimeStreamState = {
        runtime: this.runtime,
        parseStructured: shouldParseStructuredOutput(this.runtime, prepared.args),
        buffer: '',
        stdoutTail: '',
        sawStructured: false,
        textSnapshots: new Map<string, string>(),
        thinkingSnapshots: new Map<string, string>(),
        runningTools: new Set<string>(),
        pendingTextDrains: [],
        context: null,
      };
      let stderrBuffer = '';
      let stderrTail = '';
      let lastProcessUpdateAt = 0;
      let timedOut = false;
      let closed = false;
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
      };
      const sendProcessUpdate = (extra: Record<string, unknown> = {}) => {
        const { force: forceUpdate, ...details } = extra;
        const now = Date.now();
        if (now - lastProcessUpdateAt < 750 && !forceUpdate) return;
        lastProcessUpdateAt = now;
        pushProcessUpdate(queue, prepared, cwd, startedAt, files, streamState.stdoutTail, stderrTail, details);
      };
      const heartbeat = setInterval(() => {
        sendProcessUpdate({ phase: 'running', force: true });
      }, 2_000);
      heartbeat.unref();
      const timeoutMs = commandTimeoutMs(this.runtime);

      sendProcessUpdate({ phase: 'starting', timeoutSeconds: timeoutMs == null ? null : timeoutMs / 1000, force: true });

      const child = spawn(prepared.executable, prepared.args, {
        cwd,
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(prepared.executable),
        env: {
          ...process.env,
          TERM: 'dumb',
          NO_COLOR: '1',
          BEES_RUNTIME: this.runtime,
          BEES_TASK_ID: options?.task?.id ?? sessionId,
          BEES_TASK_TITLE: options?.task?.title ?? '',
          BEES_TASK_REPO: options?.task?.workspacePath ?? '',
          BEES_TASK_MESSAGE: message,
          BEES_TASK_SYSTEM_PROMPT: options?.systemMessage ?? '',
          BEES_TASK_PROMPT_FILE: files.promptFile,
          BEES_TASK_CONTEXT_FILE: files.contextFile,
          XDG_CONFIG_HOME: this.runtime === 'opencode' ? xdgConfigHome : process.env.XDG_CONFIG_HOME,
          XDG_DATA_HOME: this.runtime === 'opencode' ? xdgDataHome : process.env.XDG_DATA_HOME,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        handleStdoutChunk(chunk, streamState, queue);
        sendProcessUpdate({ phase: 'stdout' });
      });

      child.stderr.on('data', (chunk) => {
        const text = filterBenignRuntimeStderr(this.runtime, stripAnsi(String(chunk)));
        if (!text.trim()) return;
        stderrBuffer += text;
        stderrTail = appendTail(stderrTail, text);
        sendProcessUpdate({ phase: 'stderr' });
      });

      child.on('error', (error) => {
        clearInterval(heartbeat);
        sendProcessUpdate({ phase: 'spawn_error', error: error.message, force: true });
        queue.push({ type: 'error', error: error.message, code: 'runtime_spawn_error' });
      });

      const timeout = timeoutMs == null ? null : setTimeout(() => {
        timedOut = true;
        stderrTail = appendTail(stderrTail, `\nProcess timed out after ${(timeoutMs / 1000).toFixed(0)} seconds.\n`);
        sendProcessUpdate({ phase: 'timeout', timedOut: true, force: true });
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!closed) child.kill('SIGKILL');
        }, 5_000).unref();
      }, timeoutMs);
      timeout?.unref();

      child.stdin.write(promptText);
      child.stdin.end();

      child.on('close', (code) => {
        void (async () => {
          closed = true;
          clearInterval(heartbeat);
          if (timeout) clearTimeout(timeout);
          flushStdout(streamState, queue);
          await waitForPendingText(streamState);
          const duration = (Date.now() - startedAt) / 1000;
          if (code === 0) {
            queue.push({
              type: 'tool_progress',
              tool: 'process',
              status: 'completed',
              duration,
              label: prepared.label || this.command,
              details: processDetails(prepared, cwd, startedAt, files, streamState.stdoutTail, stderrTail, { exitCode: code }),
            });
            queue.push({ type: 'done', sessionId, context: streamState.context });
          } else {
            queue.push({
              type: 'tool_progress',
              tool: 'process',
              status: 'error',
              duration,
              label: prepared.label || this.command,
              details: processDetails(prepared, cwd, startedAt, files, streamState.stdoutTail, stderrTail, { exitCode: code, timedOut }),
            });
            const timeoutMessage = timedOut
              ? `${this.runtime} command timed out after ${timeoutMs == null ? duration.toFixed(1) : (timeoutMs / 1000).toFixed(0)} seconds`
              : null;
            queue.push({
              type: 'error',
              error: timeoutMessage ?? (stderrBuffer.trim() || `${this.runtime} command exited with code ${code ?? 'unknown'}`),
              code: timedOut ? 'runtime_timeout' : 'runtime_exit_error',
            });
            queue.push({ type: 'done', sessionId });
          }
          queue.end();
          void cleanup();
        })();
      });
    })().catch((error) => {
      queue.push({ type: 'error', error: error instanceof Error ? error.message : String(error), code: 'runtime_setup_error' });
      queue.push({ type: 'done', sessionId });
      queue.end();
    });

    for await (const event of queue) {
      yield event;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.command.trim()) return false;
    const tokens = parseCommandLine(this.command.trim());
    if (tokens.length === 0) return false;
    const executable = resolveExecutable(tokens[0]);
    if (process.platform === 'win32') return executable !== tokens[0] || existsSync(executable);
    return true;
  }

  async getModels(): Promise<AgentModelsResponse> {
    if (this.runtime === 'codex') return await discoverCodexModels(this.command);
    if (this.runtime === 'claude_code') return await discoverClaudeModels();
    return await discoverOpenCodeModels(this.command);
  }

  async getMessages(_sessionId: string, _taskId: string): Promise<TaskMessage[]> {
    return [];
  }

  async getSessionMetadata(_sessionId: string): Promise<SessionMetadata | null> {
    return null;
  }

  async judgeCompletion(
    _taskTitle: string,
    _taskDescription: string | null,
    responseText: string,
  ): Promise<{ done: boolean; reason: string }> {
    // For command-backed runtimes, the CLI process completing successfully is the
    // completion signal. If we got any response text, the task is done.
    if (responseText.trim()) {
      return { done: true, reason: `${this.runtime} command completed` };
    }
    return { done: false, reason: 'no response text produced' };
  }

  async judgeActivityIntent(
    transcript: string,
    metadata: {
      timestamp?: string | null;
      source?: string | null;
      capturedText?: string | null;
      activeWindow?: Record<string, unknown> | null;
      images?: Record<string, unknown> | null;
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
    } = {},
  ): Promise<ActivityIntentDecision> {
    const normalized = transcript.trim();
    const capturedText = metadata.capturedText?.trim() ?? '';
    if (!normalized && !capturedText) {
      return {
        action: 'save_context' as const,
        title: 'Saved voice context',
        taskDescription: '',
        hasEnoughContext: false,
        screenContextRequired: false,
        reason: 'Spoken input and captured context are empty.',
      };
    }

    const request = buildActivityIntentRequest({
      transcript: normalized,
      timestamp: metadata.timestamp,
      source: metadata.source,
      capturedText,
      activeWindow: metadata.activeWindow,
      images: metadata.images,
    });
    const result = await this.chat(`activity-intent-${randomUUID()}`, request, {
      systemMessage: ACTIVITY_INTENT_SYSTEM_PROMPT,
      task: {
        id: `activity-intent-${randomUUID()}`,
        title: 'Activity intent classification',
        workspacePath: null,
      },
      settings: {
        runtime: this.runtime,
        model: metadata.model ?? null,
        reasoningEffort: metadata.reasoningEffort ?? null,
      },
    });
    const parsed = parseJsonObject(result.text) as Partial<ActivityIntentDecision>;
    return normalizeActivityIntentDecision(parsed, normalized || capturedText);
  }
}
