export const TASK_STATUSES = ['assigned', 'pending', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_MODES = ['direct', 'plan'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_KINDS = ['task', 'chat'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const AGENT_RUNTIMES = ['hermes', 'codex', 'claude_code', 'opencode'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
export type AgentRuntimeModelControl = 'none' | 'picker' | 'text';
export type AgentRuntimeReasoningControl = 'none' | 'picker';

export interface AgentRunSettings {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  runtime?: AgentRuntime | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  task_kind: TaskKind;
  task_mode: TaskMode;
  workspace_path: string | null;
  organization_id: string | null;
  creator_developer_id: string | null;
  creator_email: string | null;
  creator_first_name: string | null;
  creator_last_name: string | null;
  team_id: string | null;
  team_name: string | null;
  assignee_developer_id: string | null;
  assignee_email: string | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
  agent_runtime: AgentRuntime | null;
  agent_model: string | null;
  reasoning_effort: ReasoningEffort | null;
  created_at: number;
  updated_at: number;
  last_agent_response_at: number | null;
  last_viewed_at: number | null;
  last_context_used_tokens: number | null;
  last_context_window_tokens: number | null;
}

export interface Project {
  path: string;
  label: string | null;
  organization_id?: string | null;
  creator_developer_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: number;
}

export interface ToolProgressEvent {
  tool: string;
  status: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  details?: unknown;
}

export type TaskRunKind = 'chat' | 'compact';
export type LiveChatTimelineItem =
  | { id: string; type: 'text'; content: string; created_at: number }
  | { id: string; type: 'thinking'; content: string; created_at: number }
  | { id: string; type: 'tool'; tool: ToolProgressEvent; created_at: number; updated_at?: number }
  | { id: string; type: 'error'; error: string; created_at: number };

export type LiveChatRunStatus = 'streaming' | 'compacting' | 'done' | 'error' | 'stopped';

export interface TaskRunState {
  taskId: string;
  runId: string;
  kind: TaskRunKind;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
}

export type BoardEvent =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_deleted'; taskId: string; task?: Task }
  | { type: 'activity_draft_created'; context: ActivityContext }
  | { type: 'activity_context_created'; context: ActivityContext }
  | { type: 'activity_context_updated'; context: ActivityContext }
  | { type: 'activity_context_deleted'; contextId: string }
  | { type: 'project_saved'; project: Project }
  | { type: 'project_deleted'; path: string; taskIds: string[] }
  | { type: 'task_runs_snapshot'; runs: TaskRunState[] }
  | { type: 'task_run_updated'; run: TaskRunState }
  | { type: 'voice_wake_ack' }
  | { type: 'voice_task_started'; taskId: string }
  | { type: 'voice_conversation_reply'; sessionId: string; transcript: string };

export type LiveChatMessage = TaskMessage & { tools?: ToolProgressEvent[]; timeline?: LiveChatTimelineItem[] };

export interface LiveChatRun {
  taskId: string;
  runId: string;
  kind: TaskRunKind;
  sessionId: string;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  messages: LiveChatMessage[];
  context?: ContextUsage | null;
  error?: string;
}

export interface ContextUsage {
  used_tokens: number;
  window_tokens: number;
}

export interface CompactResult {
  compressed: boolean;
  sessionId: string;
  previousMessageCount: number;
  compressedMessageCount: number;
  context?: ContextUsage | null;
}

export interface ChatAttachment {
  id: string;
  name: string;
  path: string;
  viewUrl?: string;
  downloadUrl?: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  visualSummary?: string;
}

export interface ActivityIntentDecision {
  action: 'create_task' | 'save_context';
  title: string;
  taskDescription: string;
  hasEnoughContext: boolean;
  screenContextRequired: boolean;
  reason: string;
}

export interface ActivityContext {
  id: string;
  source_event_id: string | null;
  trigger: string;
  spoken_input: string | null;
  captured_text: string | null;
  active_window: Record<string, unknown> | null;
  images: Record<string, unknown> | null;
  decision: ActivityIntentDecision | null;
  promoted_task_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionMetadata {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: string | null;
  model: string | null;
}

export interface AgentDefaults {
  runtime: AgentRuntime | null;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  reasoningEffort: ReasoningEffort | null;
  showReasoning: boolean;
}

export interface AgentRuntimeOption {
  id: AgentRuntime;
  label: string;
  description: string;
  supportsGoals: boolean;
  status: 'ready' | 'configure';
  command: string | null;
  installed: boolean;
  installable: boolean;
  packageName?: string;
  installCommand?: string;
  modelControl: AgentRuntimeModelControl;
  reasoningControl: AgentRuntimeReasoningControl;
}

export interface AgentRuntimesResponse {
  defaultRuntime: AgentRuntime;
  options: AgentRuntimeOption[];
}

export interface AgentRuntimeInstallResponse {
  runtime: AgentRuntime;
  installed: boolean;
  command: string | null;
  packageName: string;
  installCommand: string;
  output?: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  source: 'current' | 'catalog' | 'custom' | 'alias';
  isCurrentDefault?: boolean;
  pricing?: AgentModelPricing;
}

export type AgentModelPricingUnit =
  | 'million_tokens'
  | 'image'
  | 'video'
  | 'audio_minute'
  | 'request'
  | 'unknown';

export interface AgentModelPricing {
  unit: AgentModelPricingUnit;
  inputUsd?: number | null;
  outputUsd?: number | null;
  cachedInputUsd?: number | null;
  display?: string | null;
}

export interface AgentModelGroup {
  provider: string;
  models: AgentModelOption[];
}

export interface AgentModelsResponse {
  runtime: AgentRuntime;
  defaultModel: string | null;
  activeProvider: string | null;
  groups: AgentModelGroup[];
}

export interface AsrStatusResponse {
  enabled: boolean;
  available: boolean;
  model: string;
  device: string;
  dtype: string;
  error?: string;
}

export interface AsrTranscriptionResponse {
  text: string;
  language: string | null;
  durationMs: number;
}

export interface AsrTaskIntentResponse {
  transcript: AsrTranscriptionResponse;
  decision: ActivityIntentDecision;
  actionTaken: 'task_created' | 'task_created_started' | 'insert_for_edit';
  task?: Task;
  error?: string;
}

export interface TaskAgentSettings {
  task: {
    runtime: AgentRuntime | null;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
  defaults: AgentDefaults;
  runtimes: AgentRuntimesResponse;
  effective: {
    runtime: AgentRuntime;
    model: string | null;
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
}

export interface CronJobOrigin {
  platform?: string | null;
  chat_id?: string | null;
  chat_name?: string | null;
  thread_id?: string | null;
  [key: string]: unknown;
}

export interface CronJob {
  id: string;
  name: string;
  prompt: string | null;
  schedule: Record<string, unknown> | null;
  scheduleDisplay: string | null;
  enabled: boolean;
  state: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: CronStatus | null;
  lastError: string | null;
  lastDeliveryError: string | null;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
  deliver: string | null;
  origin: CronJobOrigin | null;
  skills: string[];
  createdAt: string | null;
  linkedTaskIds?: string[];
}

export type CronStatus = 'ok' | 'error' | 'unknown';

export interface CronRun {
  id: string;
  jobId: string;
  ranAt: string | null;
  path: string;
  status: CronStatus;
  preview: string;
  content?: string;
}

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  displayPath: string;
  type: FileEntryType;
  hidden: boolean;
  size: number | null;
  modifiedAt: number | null;
  readable: boolean;
  writable: boolean;
}

export interface FileListResponse {
  path: string;
  displayPath: string;
  parentPath: string | null;
  entries: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  displayPath: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: number;
  encoding: 'utf8';
  fileType: 'text';
}

export interface FileWriteResponse {
  path: string;
  displayPath: string;
  size: number;
  modifiedAt: number;
}

export type FileCreateType = 'file' | 'directory';

export interface FileCreateResponse {
  entry: FileEntry;
}

export interface FileRenameResponse {
  entry: FileEntry;
}

export interface FileDeleteResponse {
  ok: true;
}

export interface FileUploadResponse {
  uploaded: number;
  entries: FileEntry[];
}
