import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPythonLlmClient } from '../../src/integrations/python-llm/mock-llm-client.js';
import { connectTestDb, createTestApp, disconnectTestDb } from '../helpers/test-app.js';

describe('health endpoints', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it('liveness does not touch dependencies', async () => {
    const t = createTestApp();
    const res = await supertest(t.app).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness reports MongoDB and the Python service', async () => {
    const t = createTestApp();
    const res = await supertest(t.app).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { mongodb: 'ok', pythonLlm: 'ok' } });
  });

  it('stays ready but degraded when the Python service is down', async () => {
    const t = createTestApp({ llmClient: new MockPythonLlmClient({ healthy: false }) });
    const res = await supertest(t.app).get('/health/ready').expect(200);
    expect(res.body).toEqual({
      status: 'degraded',
      checks: { mongodb: 'ok', pythonLlm: 'unavailable' },
    });
  });

  it('reports not ready during shutdown', async () => {
    const t = createTestApp();
    t.container.lifecycle.shuttingDown = true;
    const res = await supertest(t.app).get('/health/ready').expect(503);
    expect(res.body.status).toBe('unavailable');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const t = createTestApp();
    const res = await supertest(t.app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
