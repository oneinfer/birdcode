import { Router } from 'express';
import { initSSE } from '../events.js';
import { getRun, sendSnapshot, subscribe } from '../live-chat.js';
import { graniteAsr } from '../asr/granite-worker.js';
import { liveTts } from '../tts/live-tts.js';
import { installAudioAssistantRuntime } from '../audio-assistant-install.js';
import { toErrorMessage } from '../errors.js';

export const voiceAssistantRouter = Router();

voiceAssistantRouter.get('/runtime/status', async (_req, res) => {
  const [asr, tts] = await Promise.all([graniteAsr.status(), liveTts.status()]);
  res.json({ asr, tts, installed: asr.available && tts.enabled });
});

voiceAssistantRouter.post('/runtime/install', async (_req, res) => {
  try {
    res.json(await installAudioAssistantRuntime());
  } catch (error) {
    const [asr, tts] = await Promise.all([
      graniteAsr.status().catch((statusError) => ({ enabled: true, available: false, model: '', device: 'cpu', dtype: 'float32', error: toErrorMessage(statusError, 'ASR unavailable') })),
      liveTts.status().catch((statusError) => ({ enabled: true, available: false, model: '', device: 'cpu', sampleRate: 48000, segmentMaxChars: 420, error: toErrorMessage(statusError, 'TTS unavailable') })),
    ]);
    res.status(503).json({
      error: toErrorMessage(error, 'Failed to install audio assistant dependencies'),
      installed: false,
      asr,
      tts,
    });
  }
});

// Ad-hoc voice-conversation sessions have no backing Task row (see server/voice-assistant.ts),
// so this always serves locally from the in-memory live-chat run store rather than proxying
// to the enterprise server the way task-scoped chat/live does.
voiceAssistantRouter.get('/sessions/:id/live', (req, res) => {
  const run = getRun(req.params.id);
  initSSE(res);
  subscribe(req.params.id, res);
  if (run) sendSnapshot(res, run);
});
