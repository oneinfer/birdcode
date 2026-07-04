import type {
  AgentDefaults,
  ActivityContext,
  AgentModelsResponse,
  AgentRuntime,
  AgentRuntimeInstallResponse,
  AgentRuntimesResponse,
  AgentRunSettings,
  AsrStatusResponse,
  AsrTaskIntentResponse,
  AsrTranscriptionResponse,
  CronJob,
  CronRun,
  FileCreateResponse,
  FileCreateType,
  FileDeleteResponse,
  FileListResponse,
  FileReadResponse,
  FileRenameResponse,
  FileUploadResponse,
  FileWriteResponse,
  ContextUsage,
  Project,
  SessionMetadata,
  Task,
  TaskAgentSettings,
  TaskKind,
  TaskMode,
  TaskMessage,
  TaskStatus,
  ReasoningEffort,
} from '@shared/types';
import { getStoredAccessToken, hasAuthSessionCookie } from './auth-storage';
import { getSelectedOrganizationId } from './organization-selection';

export type { AgentRunSettings };

export const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: string;
  bundled: boolean;
  readOnly: boolean;
  autoIncluded: boolean;
}

export function apiAuthHeaders(): Record<string, string> {
  const token = getStoredAccessToken();
  const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(organizationId ? { 'X-Bees-Organization-Id': organizationId } : {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const authHeaders = apiAuthHeaders();
  const method = (rest.method || 'GET').toUpperCase();
  const csrfToken = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
    ? null
    : readCookie('bees_csrf_token');
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: isFormDataBody
      ? { ...authHeaders, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...extraHeaders as Record<string, string> }
      : { 'Content-Type': 'application/json', ...authHeaders, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...extraHeaders as Record<string, string> },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(message, res.status, code);
  }
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

export function fetchTasks() {
  return request<{ tasks: Task[] }>('/tasks');
}

export function fetchProjects() {
  return request<{ projects: Project[] }>('/projects');
}

export function fetchCurrentProject() {
  return request<{ workspacePath: string | null }>('/projects/current');
}

export function updateCurrentProject(workspacePath: string | null) {
  return request<{ workspacePath: string | null; project: Project | null }>('/projects/current', {
    method: 'PUT',
    body: JSON.stringify({ workspacePath }),
  });
}

export function createProject(workspacePath: string) {
  return request<{ project: Project }>('/projects', {
    method: 'POST',
    body: JSON.stringify({ workspacePath }),
  });
}

export function deleteProject(workspacePath: string) {
  return request<{ ok: boolean; taskIds: string[] }>('/projects', {
    method: 'DELETE',
    body: JSON.stringify({ workspacePath }),
  });
}

export function moveTask(id: string, status: TaskStatus) {
  return request<{ task: Task }>(`/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export function deleteTask(id: string) {
  return request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
}

export function patchTask(
  id: string,
  fields: {
    title?: string;
    description?: string;
    status?: TaskStatus;
    workspacePath?: string | null;
    runtime?: AgentRuntime | null;
    teamId?: string | null;
    assigneeDeveloperId?: string | null;
  },
) {
  return request<{ task: Task }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function startTask(
  id: string,
  settings: {
    workspacePath: string;
    runtime?: AgentRuntime | null;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    taskMode?: TaskMode;
  },
  message?: string,
  attachments?: File[],
) {
  if (attachments?.length) {
    const formData = new FormData();
    formData.append('workspacePath', settings.workspacePath);
    appendOptionalFormValue(formData, 'runtime', settings.runtime);
    appendOptionalFormValue(formData, 'model', settings.model);
    appendOptionalFormValue(formData, 'reasoningEffort', settings.reasoningEffort);
    appendOptionalFormValue(formData, 'taskMode', settings.taskMode);
    appendOptionalFormValue(formData, 'message', message);
    for (const attachment of attachments) {
      formData.append('attachments', attachment, attachment.name);
    }

    return request<{ task: Task }>(`/tasks/${id}/start`, {
      method: 'POST',
      body: formData,
    });
  }

  return request<{ task: Task }>(`/tasks/${id}/start`, {
    method: 'POST',
    body: JSON.stringify({ ...settings, message }),
  });
}

export function markTaskViewed(id: string) {
  return request<{ task: Task }>(`/tasks/${id}/viewed`, {
    method: 'POST',
  });
}

export function createTask(
  description: string,
  title?: string,
  workspacePath?: string | null,
  runtime?: AgentRuntime | null,
  model?: string | null,
  reasoningEffort?: ReasoningEffort | null,
  taskMode?: TaskMode,
  attachments?: File[],
  taskKind?: TaskKind,
  start?: boolean,
  assignment?: { teamId?: string | null; assigneeEmail?: string | null },
) {
  if (attachments?.length) {
    const formData = new FormData();
    formData.append('description', description);
    appendOptionalFormValue(formData, 'title', title);
    appendOptionalFormValue(formData, 'taskKind', taskKind);
    appendOptionalFormValue(formData, 'teamId', assignment?.teamId);
    appendOptionalFormValue(formData, 'assigneeEmail', assignment?.assigneeEmail);
    for (const attachment of attachments) {
      formData.append('attachments', attachment, attachment.name);
    }

    return request<{ task: Task }>('/tasks', {
      method: 'POST',
      body: formData,
    });
  }

  return request<{ task: Task }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      description,
      title,
      taskKind,
      teamId: assignment?.teamId,
      assigneeEmail: assignment?.assigneeEmail,
    }),
  });
}

export function fetchMessages(taskId: string) {
  return request<{ messages: TaskMessage[]; context?: ContextUsage | null }>(`/tasks/${taskId}/messages`);
}

export function fetchSession(taskId: string) {
  return request<{ session: SessionMetadata | null }>(`/tasks/${taskId}/session`);
}

export function fetchHealth() {
  return request<{ ok: boolean; hermes: boolean; runtimes: Record<AgentRuntime, boolean>; asr: AsrStatusResponse; tts?: TtsStatusResponse }>('/health');
}

export interface TtsStatusResponse {
  enabled: boolean;
  available: boolean;
  model: string;
  device: string;
  sampleRate: number;
  segmentMaxChars: number;
  error?: string;
}

export function fetchAsrStatus() {
  return request<AsrStatusResponse>('/asr/status');
}

export function fetchTtsStatus() {
  return request<TtsStatusResponse>('/tts/status');
}

export interface ActivityDaemonStatusResponse {
  enabled: boolean;
  available: boolean;
  managed: boolean;
  url: string;
  error?: string;
  daemon?: unknown;
}

export function startActivityAssistant() {
  return request<ActivityDaemonStatusResponse>('/activity/start', { method: 'POST' });
}

export function stopActivityAssistant() {
  return request<ActivityDaemonStatusResponse>('/activity/stop', { method: 'POST' });
}

export function liveTaskTtsUrl(taskId: string) {
  const params = new URLSearchParams();
  const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
  const accessToken = getStoredAccessToken();
  if (organizationId) params.set('organizationId', organizationId);
  if (accessToken) params.set('accessToken', accessToken);
  const query = params.toString();
  return `${BASE}/tts/tasks/${encodeURIComponent(taskId)}/live${query ? `?${query}` : ''}`;
}

export function liveTaskChatUrl(taskId: string) {
  const params = new URLSearchParams();
  const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
  const accessToken = getStoredAccessToken();
  if (organizationId) params.set('organizationId', organizationId);
  if (accessToken) params.set('accessToken', accessToken);
  const query = params.toString();
  return `${BASE}/tasks/${encodeURIComponent(taskId)}/live${query ? `?${query}` : ''}`;
}

export function liveVoiceSessionTtsUrl(sessionId: string) {
  const params = new URLSearchParams();
  const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
  const accessToken = getStoredAccessToken();
  if (organizationId) params.set('organizationId', organizationId);
  if (accessToken) params.set('accessToken', accessToken);
  const query = params.toString();
  return `${BASE}/tts/sessions/${encodeURIComponent(sessionId)}/live${query ? `?${query}` : ''}`;
}

export function liveVoiceSessionChatUrl(sessionId: string) {
  const params = new URLSearchParams();
  const organizationId = hasAuthSessionCookie() ? getSelectedOrganizationId() : null;
  const accessToken = getStoredAccessToken();
  if (organizationId) params.set('organizationId', organizationId);
  if (accessToken) params.set('accessToken', accessToken);
  const query = params.toString();
  return `${BASE}/voice-assistant/sessions/${encodeURIComponent(sessionId)}/live${query ? `?${query}` : ''}`;
}

export function synthesizeTts(text: string) {
  return request<{ sampleRate: number; format: 'pcm_s16le'; audioBase64: string; sampleCount?: number }>('/tts/synthesize', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function transcribeAudio(audio: Blob, language?: string) {
  const formData = new FormData();
  const extension = audio.type.includes('wav') ? 'wav' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  formData.append('audio', audio, `speech.${extension}`);
  appendOptionalFormValue(formData, 'language', language);

  return request<AsrTranscriptionResponse>('/asr/transcribe', {
    method: 'POST',
    body: formData,
  });
}

export function transcribeTaskIntentAudio(
  audio: Blob,
  options: {
    language?: string;
    workspacePath?: string | null;
    runtime?: AgentRuntime | null;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    taskMode?: TaskMode;
    start?: boolean;
  } = {},
) {
  const formData = new FormData();
  const extension = audio.type.includes('wav') ? 'wav' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  formData.append('audio', audio, `speech.${extension}`);
  appendOptionalFormValue(formData, 'language', options.language);
  appendOptionalFormValue(formData, 'workspacePath', options.workspacePath);
  appendOptionalFormValue(formData, 'runtime', options.runtime);
  appendOptionalFormValue(formData, 'model', options.model);
  appendOptionalFormValue(formData, 'reasoningEffort', options.reasoningEffort);
  appendOptionalFormValue(formData, 'taskMode', options.taskMode);
  if (options.start !== undefined) formData.append('start', String(options.start));

  return request<AsrTaskIntentResponse>('/asr/transcribe-task-intent', {
    method: 'POST',
    body: formData,
  });
}

export function suppressActivitySpeechInput(reason = 'browser voice input', ttlSeconds = 180) {
  return request<{ token: string; suppressed: boolean; lease_count: number; ttl_seconds: number }>('/activity/speech/suppress', {
    method: 'POST',
    body: JSON.stringify({ reason, ttl_seconds: ttlSeconds }),
  });
}

export function releaseActivitySpeechInput(token?: string | null) {
  return request<{ suppressed: boolean; lease_count: number }>('/activity/speech/release', {
    method: 'POST',
    body: JSON.stringify(token ? { token } : {}),
  });
}

export function updateActivityAgentSettings(settings: AgentRunSettings) {
  return request<{ runtime: AgentRuntime; model: string | null; reasoningEffort: ReasoningEffort | null; updatedAt: number }>('/activity/active-agent-settings', {
    method: 'POST',
    body: JSON.stringify(settings),
  });
}

export function armActivitySelection(spokenInput?: string | null) {
  return request<{ armed: boolean; timeout_seconds?: number; spoken_input?: string; suppressed?: boolean }>('/activity/arm', {
    method: 'POST',
    body: JSON.stringify({ spoken_input: spokenInput?.trim() || '[input pending]' }),
  });
}

export function captureActivityScreenshot(spokenInput?: string | null) {
  return request<Record<string, unknown>>('/activity/capture', {
    method: 'POST',
    body: JSON.stringify({
      trigger: 'manual_screenshot',
      spoken_input: spokenInput?.trim() || '[input pending]',
      include_base64: true,
      include_full_screen: true,
      include_cursor_crop: false,
      include_selection_crop: false,
    }),
  });
}

export function fetchActivityContexts() {
  return request<{ contexts: ActivityContext[] }>('/activity-contexts');
}

export function fetchActivityContext(id: string) {
  return request<{ context: ActivityContext }>(`/activity-contexts/${id}`);
}

export function deleteActivityContext(id: string) {
  return request<{ ok: boolean }>(`/activity-contexts/${id}`, { method: 'DELETE' });
}

export function promoteActivityContext(id: string, title?: string, description?: string) {
  return request<{ task: Task; context: ActivityContext }>(`/activity-contexts/${id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ title, description }),
  });
}

export function fetchAgentDefaults() {
  return request<AgentDefaults>('/agent/defaults');
}

export function pickWorkspaceDirectory(initialPath?: string | null) {
  return request<{ path: string | null }>('/system/select-directory', {
    method: 'POST',
    body: JSON.stringify({ initialPath: initialPath ?? null }),
  });
}

export function openSystemPath(path: string) {
  return request<{ ok: boolean }>('/system/open-path', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export function fetchAgentModels(runtime?: AgentRuntime | null) {
  const query = runtime ? `?runtime=${encodeURIComponent(runtime)}` : '';
  return request<AgentModelsResponse>(`/agent/models${query}`);
}

export function fetchAgentRuntimes() {
  return request<AgentRuntimesResponse>('/agent/runtimes');
}

export function installAgentRuntime(runtime: AgentRuntime) {
  return request<AgentRuntimeInstallResponse>(`/agent/runtimes/${encodeURIComponent(runtime)}/install`, {
    method: 'POST',
  });
}

export function updateAgentDefaults(updates: { runtime?: AgentRuntime | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) {
  return request<AgentDefaults>('/agent/defaults', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}


export function fetchCronJobs(includeDisabled = true) {
  return request<{ jobs: CronJob[] }>(`/cron/jobs?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
}

export function fetchSkills() {
  return request<{ skills: SkillMeta[] }>('/skills');
}

export function fetchSkillContent(id: string) {
  return request<{ skill: SkillMeta; content: string }>(`/skills/${encodeURIComponent(id)}/content`);
}

export function listFiles(path = '~/.bees/workspace') {
  return request<FileListResponse>(`/files/list?path=${encodeURIComponent(path)}`);
}

export function readFile(path: string) {
  return request<FileReadResponse>(`/files/read?path=${encodeURIComponent(path)}`);
}

export function fileDownloadUrl(path: string) {
  return `${BASE}/files/download?path=${encodeURIComponent(path)}`;
}

export function fileViewUrl(path: string) {
  return `${BASE}/files/view?path=${encodeURIComponent(path)}`;
}

export function writeFile(path: string, content: string, expectedModifiedAt?: number, overwrite = false) {
  return request<FileWriteResponse>('/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedModifiedAt, overwrite }),
  });
}

export function createFileEntry(parentPath: string, name: string, type: FileCreateType, content?: string) {
  return request<FileCreateResponse>('/files/create', {
    method: 'POST',
    body: JSON.stringify({ parentPath, name, type, content }),
  });
}

export function renameFileEntry(path: string, newName: string) {
  return request<FileRenameResponse>('/files/rename', {
    method: 'PATCH',
    body: JSON.stringify({ path, newName }),
  });
}

export function uploadFileEntries(parentPath: string, files: File[]) {
  const formData = new FormData();
  formData.append('targetPath', parentPath);

  for (const file of files) {
    const relativePath = fileRelativePath(file);
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePath);
  }

  return request<FileUploadResponse>('/files/upload', {
    method: 'POST',
    body: formData,
  });
}

export function deleteFileEntry(path: string, recursive = false) {
  return request<FileDeleteResponse>('/files', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  });
}

export function fetchCronRuns(jobId: string, limit = 20) {
  return request<{ runs: CronRun[] }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`);
}

export function fetchCronRunContent(jobId: string, runId: string) {
  return request<{ content: string }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseCronJob(jobId: string, reason?: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
  });
}

export function runCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  });
}

export function deleteCronJob(jobId: string) {
  return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}

function appendOptionalFormValue(formData: FormData, key: string, value: string | null | undefined): void {
  if (value !== undefined && value !== null && value !== '') formData.append(key, value);
}
