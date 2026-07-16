import { Router } from 'express';
import { getTask } from '../db/queries.js';
import { liveTts } from '../tts/live-tts.js';
import { luxTts } from '../tts/lux-worker.js';
import { toErrorMessage } from '../errors.js';
import { loadOrganizationAccess, requireTaskVisible } from '../organization-access.js';
import { hasSelectedOrganization } from '../enterprise-client.js';

export const ttsRouter = Router();

ttsRouter.get('/status', async (_req, res) => {
  res.json(await liveTts.status());
});

ttsRouter.post('/synthesize', async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const result = await luxTts.synthesize(text.trim());
    res.json(result);
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'LuxTTS synthesis failed') });
  }
});

ttsRouter.get('/tasks/:id/live', async (req, res) => {
  if (!hasSelectedOrganization(req)) {
    try {
      const organizationContext = await loadOrganizationAccess(req);
      const task = requireTaskVisible(getTask(req.params.id), organizationContext);
      if (!task) return res.status(404).json({ error: 'Task not found' });
    } catch (error) {
      return res.status(403).json({ error: toErrorMessage(error, 'Organization access denied') });
    }
  }
  liveTts.subscribe(req.params.id, res);
});

// Ad-hoc voice-conversation sessions have no backing Task row, so there's nothing to
// ACL against here beyond the blanket /api org-auth middleware — same as /synthesize.
ttsRouter.get('/sessions/:id/live', (req, res) => {
  liveTts.subscribe(req.params.id, res);
});
