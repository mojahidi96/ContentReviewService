import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpPythonLlmClient } from '../../src/integrations/python-llm/http-llm-client.js';
import {
  LlmAbortedError,
  LlmBadResponseError,
  LlmContentTooLargeError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../../src/integrations/python-llm/llm.errors.js';
import type {
  ContentReviewRequest,
  ContentReviewResponse,
} from '../../src/integrations/python-llm/llm.types.js';
import { validContentReviewResponse } from '../fixtures/python-responses.js';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const TOKEN = 'service-token-0123456789';
const request: ContentReviewRequest = {
  requestId: 'req_1',
  content: 'The report have several mistake.',
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

function review(
  client: HttpPythonLlmClient,
  req = request,
  signal?: AbortSignal,
): Promise<ContentReviewResponse> {
  return client.reviewContent(req, {
    ...(signal ? { signal } : {}),
    correlationId: 'corr-12345678',
  });
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

  it('sends the documented request and returns the validated response', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, { ...validContentReviewResponse('req_1'), extraField: 'ignored' });
    const result = await review(client);

    expect(result).toEqual(validContentReviewResponse('req_1'));
    const sent = received[0]!;
    expect(sent.url).toBe('/internal/v1/content-reviews');
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers['x-request-id']).toBe('corr-12345678');
    expect(sent.headers['content-type']).toBe('application/json');
    // Exactly the documented fields: Python answers 422 to anything else (e.g. `categories`).
    expect(JSON.parse(sent.body)).toEqual(request);
  });

  it('omits language when not given so Python applies its default', async () => {
    handler = (_req, _body, res) => json(res, 200, validContentReviewResponse('req_1'));
    await review(client, { requestId: 'req_1', content: 'Hi' });
    expect(JSON.parse(received[0]!.body)).toEqual({ requestId: 'req_1', content: 'Hi' });
  });

  it('accepts a response with no issues and token usage', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        requestId: 'req_1',
        issues: [],
        model: 'gemini-test',
        usage: { inputTokens: 120, outputTokens: 4 },
      });
    expect(await review(client)).toEqual({
      requestId: 'req_1',
      issues: [],
      model: 'gemini-test',
      usage: { inputTokens: 120, outputTokens: 4 },
    });
  });

  it.each([
    [401, 'UNAUTHORIZED', LlmRejectedError, false, undefined],
    [413, 'CONTENT_TOO_LARGE', LlmContentTooLargeError, false, undefined],
    [422, 'INVALID_REQUEST', LlmRejectedError, false, undefined],
    [429, 'LLM_QUOTA_EXHAUSTED', LlmRateLimitedError, true, undefined],
    [502, 'INVALID_MODEL_OUTPUT', LlmBadResponseError, true, 1],
    [503, 'LLM_PROVIDER_UNAVAILABLE', LlmUnavailableError, true, 2],
    [503, 'AI_CONCURRENCY_LIMIT', LlmUnavailableError, true, 2],
    [502, 'BAD_GATEWAY', LlmUnavailableError, true, undefined],
    [500, 'INTERNAL', LlmUnavailableError, true, undefined],
    [504, 'GATEWAY_TIMEOUT', LlmTimeoutError, true, undefined],
    [400, 'SOMETHING', LlmRejectedError, false, undefined],
  ])(
    'maps HTTP %i %s to %o (retryable=%s, maxRetries=%s)',
    async (status, code, ErrorClass, retryable, maxRetries) => {
      handler = (_req, _body, res) =>
        json(res, status, { error: { code, message: 'x', requestId: 'req_1' } });
      const err = await review(client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ErrorClass);
      expect(err).toMatchObject({ retryable, maxRetries });
    },
  );

  it('keeps the upstream error code for rejected requests', async () => {
    handler = (_req, _body, res) => json(res, 422, { error: { code: 'INVALID_REQUEST' } });
    const err = (await review(client).catch((e: unknown) => e)) as LlmRejectedError;
    expect(err).toMatchObject({ upstreamStatus: 422, upstreamCode: 'INVALID_REQUEST' });
  });

  it('maps 429 with Retry-After to a rate-limit error', async () => {
    handler = (_req, _body, res) =>
      json(res, 429, { error: { code: 'LLM_QUOTA_EXHAUSTED' } }, { 'retry-after': '7' });
    const err = await review(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRateLimitedError);
    expect((err as LlmRateLimitedError).retryAfterMs).toBe(7000);
  });

  it('honors Retry-After on 503', async () => {
    handler = (_req, _body, res) =>
      json(res, 503, { error: { code: 'AI_CONCURRENCY_LIMIT' } }, { 'retry-after': '3' });
    const err = await review(client).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryAfterMs: 3000, maxRetries: 2 });
  });

  it('rejects malformed JSON', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"issues": [');
    };
    await expect(review(client)).rejects.toBeInstanceOf(LlmBadResponseError);
  });

  const issue = validContentReviewResponse('req_1').issues[0]!;
  it.each([
    ['missing issues', { requestId: 'req_1', model: 'm', usage: {} }],
    ['mismatched requestId', validContentReviewResponse('other')],
    [
      'unknown issueType',
      { ...validContentReviewResponse('req_1'), issues: [{ ...issue, issueType: 'style' }] },
    ],
    [
      'missing location',
      { ...validContentReviewResponse('req_1'), issues: [{ ...issue, location: undefined }] },
    ],
    ['old v1 shape', { requestId: 'req_1', offsetUnit: 'codepoint', findings: [] }],
  ])('rejects contract violations: %s', async (_name, body) => {
    handler = (_req, _body, res) => json(res, 200, body);
    await expect(review(client)).rejects.toBeInstanceOf(LlmBadResponseError);
  });

  it('times out slow responses', async () => {
    handler = () => {
      /* never respond */
    };
    const started = Date.now();
    await expect(review(client)).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('distinguishes caller aborts from timeouts', async () => {
    handler = () => {
      /* never respond */
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(review(client, request, controller.signal)).rejects.toBeInstanceOf(
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
    const err = await review(dead).catch((e: unknown) => e);
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
