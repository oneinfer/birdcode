import 'dotenv/config';
import { ensureHermesEnvironment } from './hermes-setup.mjs';
import { ensureGraniteAsrEnvironment } from './granite-asr-setup.mjs';
import { ensureLuxTtsEnvironment } from './lux-tts-setup.mjs';
import { ensureActivityDaemonEnvironment } from './activity-daemon-setup.mjs';
import { ensureNodeDependencies } from './node-deps-setup.mjs';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run dev');
ensureNodeDependencies({ includeDevDependencies: true });
ensureHermesEnvironment({ writeExampleEnv: true });
ensureGraniteAsrEnvironment({ enabled: true, installIfMissing: false, writeExampleEnv: true });
ensureActivityDaemonEnvironment({ installIfMissing: false, failOnInstallError: false, writeExampleEnv: true });
ensureLuxTtsEnvironment({ installIfMissing: false, writeExampleEnv: true });

process.env.NODE_ENV = 'development';
await import('../server/index.ts');
