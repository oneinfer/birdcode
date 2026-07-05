import 'dotenv/config';
import './db/index.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import app, { activityDaemon, agents, graniteAsr, liveTts } from './app.js';
import { openBrowserForDev } from './browser-opener.js';
import { getAppSetting } from './db/queries.js';
import { mountFrontend, type FrontendCleanup } from './frontend.js';
import { CURRENT_PROJECT_SETTING_KEY } from './routes/projects.js';
import { ensureBundledSkillsLinked } from './skills/catalog.js';

// Safety net: a single unhandled rejection anywhere (e.g. a fire-and-forget background task)
// must never take down the whole server — Node terminates the process on this by default.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection (continuing):', reason);
});

const PORT = parseInt(process.env.PORT || '6969', 10);

const httpServer = createServer(app);
let closeFrontend: FrontendCleanup = () => {};
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function main() {
  ensureBundledSkillsLinked();
  closeFrontend = await mountFrontend(app, httpServer);
  httpServer.listen(PORT);
  await once(httpServer, 'listening');

  const url = `http://localhost:${PORT}`;
  const startupUrl = `${url}/tasks/new`;
  const preloadAudioAssistant = process.env.BEES_AUDIO_ASSISTANT_PRELOAD?.trim().toLowerCase() === 'true';

  if (preloadAudioAssistant && graniteAsr.enabled()) {
    console.log('Loading Granite ASR model...');
    void graniteAsr.preload()
      .then(() => {
        console.log('Granite ASR model loaded.');
      })
      .catch((error) => {
        console.error('Granite ASR model failed to load:', error);
      });
  }

  void agents.hermes.start()
    .then(() => agents.modelsFor('hermes'))
    .then(() => { console.log('Agent worker pre-warmed.'); })
    .catch(() => {});

  if (preloadAudioAssistant && liveTts.enabled()) {
    console.log('Loading LuxTTS model...');
    await liveTts.preload()
      .then(() => {
        console.log('LuxTTS model loaded.');
      })
      .catch((error) => {
        console.error('LuxTTS model failed to load:', error);
      });
  }

  console.log(`Hermes Agent Mission Control running on ${url}`);
  openBrowserForDev(startupUrl);
  activityDaemon.openUiOnWake(startupUrl);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }

    httpServer.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });

    httpServer.closeAllConnections();
  });
}

async function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    httpServer.closeAllConnections();
    process.exit(1);
  }
  shuttingDown = true;

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${reason}`);
    process.exit(1);
  }, 5000);
  forceExit.unref();

  const results = await Promise.allSettled([
    closeHttpServer(),
    closeFrontend(),
    agents.stop(),
    graniteAsr.stop(),
    liveTts.stop(),
    activityDaemon.stop(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') console.error(result.reason);
  }

  clearTimeout(forceExit);
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error(error);
  void shutdown('startup-error', 1);
});
