import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { graniteAsr } from './asr/granite-worker.js';
import { activityDaemon } from './activity-daemon.js';
import { liveTts } from './tts/live-tts.js';

export interface AudioAssistantInstallResponse {
  installed: boolean;
  asr: Awaited<ReturnType<typeof graniteAsr.status>>;
  tts: Awaited<ReturnType<typeof liveTts.status>>;
  output?: string;
}

const activeInstalls = new Map<string, Promise<AudioAssistantInstallResponse>>();

function nodeScriptCommand(scriptPath: string): { executable: string; args: string[]; label: string } {
  return {
    executable: process.execPath,
    args: [scriptPath],
    label: `node ${scriptPath}`,
  };
}

function trimOutput(output: string): string {
  const normalized = output.trim();
  if (normalized.length <= 4000) return normalized;
  return normalized.slice(normalized.length - 4000);
}

async function runScript(scriptPath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const command = nodeScriptCommand(scriptPath);
  return await new Promise<string>((resolveInstall, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveInstall(output);
        return;
      }
      reject(new Error(trimOutput(output) || `${command.label} exited with code ${code ?? 'unknown'}`));
    });
  });
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  const content = readFileSync(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function refreshAudioEnvironment(): Promise<void> {
  const env = parseEnvFile(resolve(process.cwd(), '.env'));
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith('GRANITE_ASR_')
      || key.startsWith('QWEN_ASR_')
      || key.startsWith('LUX_TTS_')
      || key.startsWith('BEES_ACTIVITY_')
    ) {
      process.env[key] = value;
    }
  }
  process.env.GRANITE_ASR_ENABLED = 'true';
  process.env.LUX_TTS_ENABLED = 'true';
  await Promise.allSettled([graniteAsr.stop(), liveTts.stop(), activityDaemon.stop()]);
}

async function runAudioAssistantInstall(): Promise<AudioAssistantInstallResponse> {
  const env = {
    ...process.env,
    BEES_ACTIVITY_ENABLED: 'true',
    GRANITE_ASR_ENABLED: 'true',
    LUX_TTS_ENABLED: 'true',
  };

  const outputs: string[] = [];
  outputs.push(await runScript(resolve(process.cwd(), 'scripts/granite-asr-setup.mjs'), env));
  outputs.push(await runScript(resolve(process.cwd(), 'scripts/activity-daemon-setup.mjs'), env));
  outputs.push(await runScript(resolve(process.cwd(), 'scripts/lux-tts-setup.mjs'), env));
  process.env.GRANITE_ASR_ENABLED = 'true';
  process.env.LUX_TTS_ENABLED = 'true';
  await refreshAudioEnvironment();

  const [asr, tts] = await Promise.all([graniteAsr.status(), liveTts.status()]);
  return {
    installed: asr.available && tts.enabled,
    asr,
    tts,
    output: trimOutput(outputs.join('\n')),
  };
}

export async function installAudioAssistantRuntime(): Promise<AudioAssistantInstallResponse> {
  const existing = activeInstalls.get('audio-assistant');
  if (existing) return await existing;

  const install = runAudioAssistantInstall().finally(() => {
    activeInstalls.delete('audio-assistant');
  });
  activeInstalls.set('audio-assistant', install);
  return await install;
}
