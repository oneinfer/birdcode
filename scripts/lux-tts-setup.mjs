import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { platform } from 'node:os';

const KEYS = [
  'LUX_TTS_ENABLED','LUX_TTS_PYTHON','LUX_TTS_MODEL','LUX_TTS_DEVICE','LUX_TTS_THREADS',
  'LUX_TTS_REFERENCE_AUDIO_PATH','LUX_TTS_REFERENCE_DURATION_SECONDS','LUX_TTS_REFERENCE_RMS',
  'LUX_TTS_NUM_STEPS','LUX_TTS_T_SHIFT','LUX_TTS_SPEED',
  'LUX_TTS_RUN_LIMIT','LUX_TTS_SEGMENT_MAX_CHARS','LUX_TTS_SEGMENT_FLUSH_MS',
  'LUX_TTS_QUEUE_MAX_SEGMENTS','LUX_TTS_SEGMENT_TIMEOUT_MS','LUX_TTS_PRELOAD',
];
const DEFAULT_MODEL = 'YatharthS/LuxTTS';
const DEFAULT_REFERENCE_AUDIO = 'voice-reference.wav';
const LINACODEC_PACKAGE = 'git+https://github.com/ysharma3501/LinaCodec.git';
const PIPER_PHONEMIZE_FIND_LINKS = 'https://k2-fsa.github.io/icefall/piper_phonemize.html';
const K2_CPU_WHEEL_INDEX = 'https://k2-fsa.github.io/k2/cpu.html';
const PACKAGES = ['numpy', 'transformers<=4.57.6', 'git+https://github.com/ysharma3501/LuxTTS.git'];

function isWindows() { return platform() === 'win32'; }
function venvDir() { return resolve(process.cwd(), '.venv-granite-asr'); }
function venvPython() { return isWindows() ? join(venvDir(), 'Scripts', 'python.exe') : join(venvDir(), 'bin', 'python'); }
function venvBin() { return isWindows() ? join(venvDir(), 'Scripts') : join(venvDir(), 'bin'); }
function exists(path) { try { return existsSync(path); } catch { return false; } }
function which(name) {
  try { return execFileSync(isWindows() ? 'where.exe' : 'which', [name], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).split(/\r?\n/).map(s => s.trim()).find(Boolean) || null; }
  catch { return null; }
}
function envForVenv() {
  const current = process.env.PATH || process.env.Path || '';
  const bin = venvBin();
  const path = current.split(delimiter).some(p => resolve(p).toLowerCase() === resolve(bin).toLowerCase()) ? current : [bin, current].filter(Boolean).join(delimiter);
  return { ...process.env, VIRTUAL_ENV: venvDir(), PATH: path, Path: path, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONNOUSERSITE: '1' };
}
function run(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit', env: envForVenv() });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
}
function moduleInstalled(python, mod) { return spawnSync(python, ['-c', `import importlib.util,sys;sys.exit(0 if importlib.util.find_spec(${JSON.stringify(mod)}) else 1)`], { stdio: 'ignore', env: envForVenv() }).status === 0; }
function k2Accelerated(python) {
  return spawnSync(python, ['-c', [
    'import sys',
    'try:',
    '    import k2',
    'except Exception:',
    '    sys.exit(1)',
    'required=("swoosh_l","swoosh_r","swoosh_l_forward","swoosh_r_forward","swoosh_l_forward_and_deriv","swoosh_r_forward_and_deriv")',
    'sys.exit(0 if all(callable(getattr(k2,name,None)) for name in required) else 1)',
  ].join('\n')], { stdio: 'ignore', env: envForVenv() }).status === 0;
}
function officialK2WheelUrl(python) {
  if (!isWindows()) return '';
  const script = [
    'import re, sys, urllib.request',
    'try:',
    '    import torch',
    'except Exception:',
    '    sys.exit(1)',
    'torch_match=re.match(r"\\d+\\.\\d+\\.\\d+", torch.__version__)',
    'if not torch_match:',
    '    sys.exit(1)',
    'py=f"cp{sys.version_info.major}{sys.version_info.minor}"',
    'platform="win_amd64" if sys.maxsize > 2**32 else "win32"',
    `html=urllib.request.urlopen(${JSON.stringify(K2_CPU_WHEEL_INDEX)}, timeout=30).read().decode("utf-8", errors="ignore")`,
    'urls=sorted(set(re.findall(r"https://[^\\\"<> ]+k2-[^\\\"<> ]+\\.whl", html)))',
    'needles=("windows-cpu", f"+cpu.torch{torch_match.group(0)}", f"-{py}-{py}-{platform}.whl")',
    'matches=[url for url in urls if all(needle in url for needle in needles)]',
    'if not matches:',
    '    sys.exit(1)',
    'print(matches[-1])',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', env: envForVenv(), stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/).at(-1)?.trim() || '' : '';
}
function ensureK2Acceleration(python, installIfMissing) {
  if (k2Accelerated(python)) return true;
  const wheel = officialK2WheelUrl(python);
  if (!wheel) {
    console.warn('[lux-tts-setup] No matching official k2 Windows CPU wheel found; LuxTTS will use the PyTorch Swoosh fallback.');
    return false;
  }
  if (!installIfMissing) {
    console.warn(`[lux-tts-setup] k2 acceleration is missing. Matching wheel: ${wheel}`);
    return false;
  }
  console.log('[lux-tts-setup] Installing k2 acceleration for ZipVoice...');
  run(python, ['-m','pip','install','--upgrade','--upgrade-strategy','only-if-needed',wheel]);
  return k2Accelerated(python);
}
function transformersCompatible(python) {
  return spawnSync(python, ['-c', [
    'import importlib.metadata,sys',
    'try:',
    '    version=importlib.metadata.version("transformers")',
    'except importlib.metadata.PackageNotFoundError:',
    '    sys.exit(1)',
    'parts=[]',
    'for part in version.split(".")[:3]:',
    '    try: parts.append(int(part))',
    '    except ValueError: parts.append(0)',
    'while len(parts)<3: parts.append(0)',
    'sys.exit(0 if parts <= [4,57,6] else 1)',
  ].join('\n')], { stdio: 'ignore', env: envForVenv() }).status === 0;
}
function parseEnv(path) {
  if (!exists(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function patchEnv(path, values) {
  const old = exists(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set();
  const lines = old ? old.split(/\r?\n/).map(line => {
    const m = line.match(/^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!m || !Object.hasOwn(values, m[2])) return line;
    present.add(m[2]);
    const comment = m[4].match(/(\s+#.*)$/)?.[1] || '';
    return `${m[1]}${m[2]}${m[3]}${values[m[2]]}${comment}`;
  }) : [];
  if (lines.length && lines.at(-1) !== '') lines.push('');
  for (const key of KEYS) if (!present.has(key)) lines.push(`${key}=${values[key]}`);
  const next = lines.join('\n');
  if (next !== old) writeFileSync(path, next, 'utf8');
}
function bootstrapPython() { return process.env.LUX_TTS_BOOTSTRAP_PYTHON?.trim() || process.env.GRANITE_ASR_PYTHON?.trim() || process.env.HERMES_PYTHON?.trim() || which('python') || which('python3'); }

export function ensureLuxTtsEnvironment(options = {}) {
  const { installIfMissing = process.env.BEES_SKIP_LUX_TTS_INSTALL !== '1', writeLocalEnv = true, writeExampleEnv = true } = options;
  const local = parseEnv(resolve(process.cwd(), '.env'));
  const cfg = (key) => process.env[key]?.trim() || local[key]?.trim() || '';
  const enabled = (cfg('LUX_TTS_ENABLED') || 'false').toLowerCase() === 'true';
  const configuredPython = cfg('LUX_TTS_PYTHON') || cfg('GRANITE_ASR_PYTHON');
  const python = configuredPython && exists(configuredPython) ? configuredPython : venvPython();
  const values = {
    LUX_TTS_ENABLED: String(enabled), LUX_TTS_PYTHON: python, LUX_TTS_MODEL: cfg('LUX_TTS_MODEL') || DEFAULT_MODEL,
    LUX_TTS_DEVICE: cfg('LUX_TTS_DEVICE') || cfg('GRANITE_ASR_DEVICE') || 'cpu', LUX_TTS_THREADS: cfg('LUX_TTS_THREADS') || '2',
    LUX_TTS_REFERENCE_AUDIO_PATH: cfg('LUX_TTS_REFERENCE_AUDIO_PATH') || DEFAULT_REFERENCE_AUDIO,
    LUX_TTS_REFERENCE_DURATION_SECONDS: cfg('LUX_TTS_REFERENCE_DURATION_SECONDS') || '5',
    LUX_TTS_REFERENCE_RMS: cfg('LUX_TTS_REFERENCE_RMS') || '0.001',
    LUX_TTS_NUM_STEPS: cfg('LUX_TTS_NUM_STEPS') || '4',
    LUX_TTS_T_SHIFT: cfg('LUX_TTS_T_SHIFT') || '0.5', LUX_TTS_SPEED: cfg('LUX_TTS_SPEED') || '1.0', LUX_TTS_RUN_LIMIT: cfg('LUX_TTS_RUN_LIMIT') || '1',
    LUX_TTS_SEGMENT_MAX_CHARS: cfg('LUX_TTS_SEGMENT_MAX_CHARS') || '420', LUX_TTS_SEGMENT_FLUSH_MS: cfg('LUX_TTS_SEGMENT_FLUSH_MS') || '900',
    LUX_TTS_QUEUE_MAX_SEGMENTS: cfg('LUX_TTS_QUEUE_MAX_SEGMENTS') || '12', LUX_TTS_SEGMENT_TIMEOUT_MS: cfg('LUX_TTS_SEGMENT_TIMEOUT_MS') || '30000',
    LUX_TTS_PRELOAD: cfg('LUX_TTS_PRELOAD') || 'false',
  };
  const example = {
    ...values,
    LUX_TTS_ENABLED: String(enabled),
    LUX_TTS_PYTHON: '',
    LUX_TTS_REFERENCE_AUDIO_PATH: DEFAULT_REFERENCE_AUDIO,
  };
  if (writeExampleEnv) patchEnv(resolve(process.cwd(), '.env.example'), example);
  if (writeLocalEnv) patchEnv(resolve(process.cwd(), '.env'), values);
  Object.assign(process.env, values);
  if (!enabled) { console.log(`[lux-tts-setup] LUX_TTS_ENABLED=${values.LUX_TTS_ENABLED}`); console.log('[lux-tts-setup] LuxTTS disabled'); return { python, installed: false, venvDir: venvDir(), binDir: venvBin() }; }
  if (!exists(python)) { const source = bootstrapPython(); if (!source) throw new Error('No Python executable found for LuxTTS setup.'); if (installIfMissing) { console.log(`[lux-tts-setup] Creating ${venvDir()} with ${source}`); run(source, ['-m','venv',venvDir()]); } }
  if (!moduleInstalled(python, 'zipvoice') || !moduleInstalled(python, 'numpy') || !moduleInstalled(python, 'linacodec') || !transformersCompatible(python)) { if (!installIfMissing) console.warn('[lux-tts-setup] LuxTTS dependencies are missing and install is disabled.'); else { console.log('[lux-tts-setup] Installing LuxTTS dependencies into .venv-granite-asr...'); if (!moduleInstalled(python, 'linacodec')) run(python, ['-m','pip','install','--upgrade','--upgrade-strategy','only-if-needed',LINACODEC_PACKAGE]); run(python, ['-m','pip','install','--upgrade','--upgrade-strategy','only-if-needed','--find-links',PIPER_PHONEMIZE_FIND_LINKS,...PACKAGES]); } }
  const k2Ready = ensureK2Acceleration(python, installIfMissing);
  const ready = exists(python) && moduleInstalled(python, 'zipvoice') && moduleInstalled(python, 'numpy');
  console.log(`[lux-tts-setup] LUX_TTS_ENABLED=${values.LUX_TTS_ENABLED}`); console.log(`[lux-tts-setup] LUX_TTS_PYTHON=${values.LUX_TTS_PYTHON}`); console.log(`[lux-tts-setup] LuxTTS dependencies ${ready ? 'ready' : 'not installed'}`);
  if (isWindows()) console.log(`[lux-tts-setup] k2 acceleration ${k2Ready ? 'ready' : 'unavailable'}`);
  if (!ready && installIfMissing) throw new Error('LuxTTS dependencies were not installed successfully.');
  return { python, installed: ready, venvDir: venvDir(), binDir: venvBin() };
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('lux-tts-setup.mjs')) {
  try { ensureLuxTtsEnvironment({ writeLocalEnv: !process.argv.includes('--no-env'), writeExampleEnv: !process.argv.includes('--no-env-example'), installIfMissing: !process.argv.includes('--no-install') }); }
  catch (error) { console.error(`[lux-tts-setup] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
