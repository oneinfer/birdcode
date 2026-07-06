import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageJson() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
}

function packageDirExists(name) {
  return existsSync(resolve(process.cwd(), 'node_modules', name));
}

function findMissingDependencies(dependencies) {
  return Object.keys(dependencies).filter((name) => !packageDirExists(name));
}

export function ensureNodeDependencies(options = {}) {
  const {
    installIfMissing = process.env.BEES_SKIP_NPM_INSTALL !== '1',
    includeDevDependencies = false,
  } = options;

  const pkg = readPackageJson();
  const dependencies = {
    ...(pkg.dependencies ?? {}),
    ...(includeDevDependencies ? (pkg.devDependencies ?? {}) : {}),
  };
  const missing = findMissingDependencies(dependencies);

  if (missing.length === 0) return { installed: true, missing: [] };

  console.log(`[node-deps-setup] Missing dependencies: ${missing.join(', ')}`);

  if (!installIfMissing) {
    console.warn('[node-deps-setup] Missing dependencies detected and install is disabled.');
    return { installed: false, missing };
  }

  console.log('[node-deps-setup] Running npm install to fetch missing dependencies...');
  const result = spawnSync('npm', ['install'], { stdio: 'inherit', shell: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install exited with code ${result.status ?? 'unknown'}`);
  }

  const stillMissing = findMissingDependencies(dependencies);
  if (stillMissing.length > 0) {
    throw new Error(`npm install completed but dependencies are still missing: ${stillMissing.join(', ')}`);
  }

  console.log('[node-deps-setup] Dependencies installed.');
  return { installed: true, missing: [] };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    ensureNodeDependencies();
  } catch (error) {
    console.error(`[node-deps-setup] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
