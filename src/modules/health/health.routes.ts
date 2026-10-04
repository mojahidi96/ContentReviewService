import { Router } from 'express';
import { pingDatabase } from '../../config/database.js';
import type { PythonLlmClient } from '../../integrations/python-llm/llm-client.js';

export function createHealthRouter(deps: {
  llmClient: PythonLlmClient;
  checkPython: boolean;
  isShuttingDown: () => boolean;
}): Router {
  const router = Router();

  /** Liveness: the process is up and the event loop responds. No dependency checks. */
  router.get('/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  /**
   * Readiness: can this instance serve traffic? MongoDB is required. The Python service is
   * reported but does not fail readiness: reviews are queued durably while it is down.
   */
  router.get('/ready', async (_req, res) => {
    const [mongoOk, python] = await Promise.all([
      pingDatabase(),
      deps.checkPython ? deps.llmClient.checkHealth() : Promise.resolve(null),
    ]);
    const shuttingDown = deps.isShuttingDown();
    const ready = mongoOk && !shuttingDown;
    res
      .status(ready ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({
        status: ready ? (python?.status === 'unavailable' ? 'degraded' : 'ok') : 'unavailable',
        checks: {
          mongodb: mongoOk ? 'ok' : 'unavailable',
          ...(python ? { pythonLlm: python.status } : {}),
          ...(shuttingDown ? { shutdown: 'in_progress' } : {}),
        },
      });
  });

  return router;
}
