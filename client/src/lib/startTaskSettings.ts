import type { AgentRuntime, ReasoningEffort, TaskMode } from '@shared/types';

export interface SavedStartSettings {
  workspacePath?: string | null;
  runtime?: AgentRuntime | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  taskMode?: TaskMode;
}

const START_SETTINGS_STORAGE_KEY = 'bees:startTaskSettings';

export function readSavedStartSettings(): SavedStartSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(START_SETTINGS_STORAGE_KEY) ?? '{}') as SavedStartSettings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSavedStartSettings(settings: SavedStartSettings) {
  try {
    localStorage.setItem(START_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort convenience only.
  }
}
