import { spawn } from 'node:child_process';
import { ensureHermesEnvironment } from './hermes-setup.mjs';
import { ensureActivityDaemonEnvironment } from './activity-daemon-setup.mjs';
import { ensureNodeDependencies } from './node-deps-setup.mjs';
import { ensureSupportedNodeVersion } from './runtime.mjs';

ensureSupportedNodeVersion('npm run start');
ensureNodeDependencies();
ensureHermesEnvironment();
ensureActivityDaemonEnvironment({ installIfMissing: false, writeExampleEnv: false });

const child = spawn(process.execPath, ['dist/server/server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
