import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpPythonLlmClient } from '../../src/integrations/python-llm/http-llm-client.js';
import {
  LlmAbortedError,
  LlmBadResponseError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../../src/integrations/python-llm/llm.errors.js';
import type {
  AnalysisChunk,
  AnalysisRequest,
} from '../../src/integrations/python-llm/llm.types.js';
import { validAnalysisResponse } from '../fixtures/python-responses.js';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const TOKEN = 'service-token-0123456789';
const request: AnalysisRequest = {
  requestId: 'req_1',
  content: 'The report have several mistake.',
  categories: ['grammar', 'spelling'],
  language: 'en',
};

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function collect(
  client: HttpPythonLlmClient,
  req = request,
  signal?: AbortSignal,
): Promise<AnalysisChunk[]> {
  const chunks: AnalysisChunk[] = [];
  for await (const c of client.analyze(req, {
    ...(signal ? { signal } : {}),
    correlationId: 'corr-12345678',
  })) {
    chunks.push(c);
  }
  return chunks;
}

describe('HttpPythonLlmClient', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: Handler;
  let client: HttpPythonLlmClient;
  const received: { headers: http.IncomingHttpHeaders; body: string; url: string | undefined }[] =
    [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body, url: req.url });
        handler(req, body, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new HttpPythonLlmClient({
      baseUrl,
      serviceToken: TOKEN,
      timeoutMs: 300,
      connectTimeoutMs: 300,
      logger: pino({ level: 'silent' }),
    });
  });
  afterEach(() => {
    received.length = 0;
  });
  afterAll(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('sends the documented request and returns validated findings', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, { ...validAnalysisResponse('req_1'), extraField: 'ignored' });
    const chunks = await collect(client);

    expect(chunks).toEqual([
      { type: 'result', model: 'gpt-test', findings: validAnalysisResponse('req_1').findings },
    ]);
    const sent = received[0]!;
    expect(sent.url).toBe('/internal/v1/content-reviews');
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers['idempotency-key']).toBe('req_1');
    expect(sent.headers['x-request-id']).toBe('corr-12345678');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent.body)).toEqual(request);
  });

  it.each([
    [401, LlmRejectedError, false],
    [400, LlmRejectedError, false],
    [413, LlmRejectedError, false],
    [500, LlmUnavailableError, true],
    [502, LlmUnavailableError, true],
    [503, LlmUnavailableError, true],
    [504, LlmTimeoutError, true],
  ])('maps HTTP %i to %o (retryable=%s)', async (status, ErrorClass, retryable) => {
    handler = (_req, _body, res) =>
      json(res, status, { error: { code: 'SOMETHING', message: 'x' } });
    const err = await collect(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as LlmRejectedError).retryable).toBe(retryable);
  });

  it('keeps the upstream error code for rejected requests', async () => {
    handler = (_req, _body, res) => json(res, 422, { error: { code: 'UNSUPPORTED_LANGUAGE' } });
    const err = (await collect(client).catch((e: unknown) => e)) as LlmRejectedError;
    expect(err).toMatchObject({ upstreamStatus: 422, upstreamCode: 'UNSUPPORTED_LANGUAGE' });
  });

  it('maps 429 with Retry-After to a rate-limit error', async () => {
    handler = (_req, _body, res) =>
      json(res, 429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '7' });
    const err = await collect(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRateLimitedError);
    expect((err as LlmRateLimitedError).retryAfterMs).toBe(7000);
  });

  it('rejects malformed JSON', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"findings": [');
    };
    await expect(collect(client)).rejects.toBeInstanceOf(LlmBadResponseError);
  });

  it.each([
    ['missing findings', { requestId: 'req_1', offsetUnit: 'codepoint' }],
    ['wrong offset unit', { ...validAnalysisResponse('req_1'), offsetUnit: 'utf16' }],
    ['mismatched requestId', validAnalysisResponse('other')],
    [
      'invalid category',
      {
        ...validAnalysisResponse('req_1'),
        findings: [{ ...validAnalysisResponse('req_1').findings[0], category: 'style' }],
      },
    ],
    [
      'negative offset',
      {
        ...validAnalysisResponse('req_1'),
        findings: [{ ...validAnalysisResponse('req_1').findings[0], startOffset: -1 }],
      },
    ],
  ])('rejects contract violations: %s', async (_name, body) => {
    handler = (_req, _body, res) => json(res, 200, body);
    await expect(collect(client)).rejects.toBeInstanceOf(LlmBadResponseError);
  });

  it('times out slow responses', async () => {
    handler = () => {
      /* never respond */
    };
    const started = Date.now();
    await expect(collect(client)).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('distinguishes caller aborts from timeouts', async () => {
    handler = () => {
      /* never respond */
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(collect(client, request, controller.signal)).rejects.toBeInstanceOf(
      LlmAbortedError,
    );
  });

  it('reports an unreachable service as unavailable', async () => {
    const dead = new HttpPythonLlmClient({
      baseUrl: 'http://127.0.0.1:1',
      serviceToken: TOKEN,
      timeoutMs: 500,
      connectTimeoutMs: 300,
      logger: pino({ level: 'silent' }),
    });
    const err = await collect(dead).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(await dead.checkHealth()).toMatchObject({ status: 'unavailable' });
    await dead.close();
  });

  it('checks health with the service credential', async () => {
    handler = (_req, _body, res) => json(res, 200, { status: 'ok' });
    expect(await client.checkHealth()).toMatchObject({ status: 'ok' });
    expect(received[0]).toMatchObject({ url: '/internal/v1/health' });
    expect(received[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    handler = (_req, _body, res) => json(res, 503, { status: 'down' });
    expect(await client.checkHealth()).toMatchObject({ status: 'unavailable' });
  });
});
