import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentModel } from '../../src/modules/documents/document.model.js';
import {
  clearTestDb,
  connectTestDb,
  createTestApp,
  disconnectTestDb,
  newAgent,
  registerUser,
  type Agent,
  type TestApp,
} from '../helpers/test-app.js';

/** Indentation, tabs, CRLF, blank lines, trailing spaces, NBSP, emoji and a combining mark. */
const FORMATTED = [
  '  Two-space indent',
  '\tTab indent',
  '    \t Mixed indent   ',
  '',
  '',
  'Windows line\r\nending, trailing spaces   ',
  'Non-breaking space, emoji 😀 👋🏽, é',
  '   ',
].join('\n');

describe('document API', () => {
  let t: TestApp;
  let alice: Agent;
  let csrf: string;

  const create = (body: Record<string, unknown>) =>
    alice.post('/api/v1/documents').set('X-CSRF-Token', csrf).send(body);
  const update = (id: string, body: Record<string, unknown>) =>
    alice.put(`/api/v1/documents/${id}`).set('X-CSRF-Token', csrf).send(body);

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp({ env: { DOCUMENT_MAX_CONTENT_CHARS: '200' } });
  });
  beforeEach(async () => {
    await clearTestDb();
    alice = newAgent(t.app);
    csrf = (await registerUser(alice)).csrfToken;
  });
  afterAll(disconnectTestDb);

  it('requires authentication', async () => {
    const anon = newAgent(t.app);
    for (const path of ['/api/v1/documents', '/api/v1/documents/0123456789abcdef01234567']) {
      const res = await anon.get(path).expect(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    }
  });

  it('requires a CSRF token for writes', async () => {
    const res = await alice
      .post('/api/v1/documents')
      .send({ title: 'Doc', content: 'x' })
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('stores content byte-for-byte, keeping indentation, whitespace and line endings', async () => {
    const created = await create({ title: '  Report  ', content: FORMATTED }).expect(201);
    const doc = created.body.document;
    expect(created.headers.location).toBe(`/api/v1/documents/${doc.documentId}`);
    expect(doc).toEqual({
      documentId: expect.stringMatching(/^[a-f0-9]{24}$/),
      title: 'Report', // titles are trimmed; content never is
      content: FORMATTED,
      contentLength: Array.from(FORMATTED).length,
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const fetched = await alice.get(`/api/v1/documents/${doc.documentId}`).expect(200);
    expect(fetched.body.document.content).toBe(FORMATTED);
    expect(Buffer.from(fetched.body.document.content, 'utf8')).toEqual(
      Buffer.from(FORMATTED, 'utf8'),
    );
    const stored = await DocumentModel.findById(doc.documentId).lean();
    expect(stored?.content).toBe(FORMATTED);
  });

  it('allows an empty document', async () => {
    const res = await create({ title: 'Blank', content: '' }).expect(201);
    expect(res.body.document).toMatchObject({ content: '', contentLength: 0 });
  });

  it('updates with the current version and bumps it', async () => {
    const { documentId } = (await create({ title: 'Doc', content: 'v1' }).expect(201)).body
      .document;
    const res = await update(documentId, {
      title: 'Doc 2',
      content: `${FORMATTED}\n`,
      version: 1,
    }).expect(200);
    expect(res.body.document).toMatchObject({
      title: 'Doc 2',
      content: `${FORMATTED}\n`,
      version: 2,
    });
  });

  it('rejects a stale version without writing anything', async () => {
    const { documentId } = (await create({ title: 'Doc', content: 'original' }).expect(201)).body
      .document;
    await update(documentId, { title: 'Doc', content: 'tab A', version: 1 }).expect(200);

    const res = await update(documentId, { title: 'Doc', content: 'tab B', version: 1 }).expect(
      409,
    );
    expect(res.body.error.code).toBe('DOCUMENT_VERSION_CONFLICT');
    const stored = await DocumentModel.findById(documentId).lean();
    expect(stored).toMatchObject({ content: 'tab A', version: 2 });
  });

  it.each([
    ['missing title', { content: 'x' }, 'body.title'],
    ['blank title', { title: '   ', content: 'x' }, 'body.title'],
    ['missing content', { title: 'Doc' }, 'body.content'],
    ['too long', { title: 'Doc', content: '😀'.repeat(201) }, 'body.content'],
    ['lone surrogate', { title: 'Doc', content: 'a\ud800b' }, 'body.content'],
    ['unknown field', { title: 'Doc', content: 'x', extra: 1 }, 'body'],
  ])('rejects %s', async (_label, body, path) => {
    const res = await create(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('counts the limit in code points', async () => {
    await create({ title: 'Doc', content: '😀'.repeat(200) }).expect(201); // 400 UTF-16 units
  });

  it('requires a version on update', async () => {
    const { documentId } = (await create({ title: 'Doc', content: 'x' }).expect(201)).body.document;
    const res = await update(documentId, { title: 'Doc', content: 'y' }).expect(400);
    expect(res.body.error.details[0].path).toBe('body.version');
  });

  it("hides other users' documents behind 404", async () => {
    const { documentId } = (await create({ title: 'Private', content: 'secret' }).expect(201)).body
      .document;
    const bob = newAgent(t.app);
    const bobCsrf = (await registerUser(bob)).csrfToken;

    expect((await bob.get(`/api/v1/documents/${documentId}`).expect(404)).body.error.code).toBe(
      'DOCUMENT_NOT_FOUND',
    );
    await bob
      .put(`/api/v1/documents/${documentId}`)
      .set('X-CSRF-Token', bobCsrf)
      .send({ title: 'Hijack', content: 'x', version: 1 })
      .expect(404);
    await bob.delete(`/api/v1/documents/${documentId}`).set('X-CSRF-Token', bobCsrf).expect(404);
    expect((await bob.get('/api/v1/documents').expect(200)).body.total).toBe(0);
    expect((await DocumentModel.findById(documentId).lean())?.content).toBe('secret');
  });

  it('rejects a malformed id with 400', async () => {
    const res = await alice.get('/api/v1/documents/not-an-id').expect(400);
    expect(res.body.error.details[0].path).toBe('params.documentId');
  });

  it('lists summaries newest-updated first, without content', async () => {
    const a = (await create({ title: 'A', content: 'aaa' }).expect(201)).body.document;
    await create({ title: 'B', content: 'bbb' }).expect(201);
    await update(a.documentId, { title: 'A', content: 'aaa!', version: 1 }).expect(200);

    const res = await alice.get('/api/v1/documents?limit=1').expect(200);
    expect(res.body).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(res.body.items).toEqual([
      {
        documentId: a.documentId,
        title: 'A',
        contentLength: 4,
        version: 2,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('deletes a document', async () => {
    const { documentId } = (await create({ title: 'Doc', content: 'x' }).expect(201)).body.document;
    await alice.delete(`/api/v1/documents/${documentId}`).set('X-CSRF-Token', csrf).expect(204);
    await alice.get(`/api/v1/documents/${documentId}`).expect(404);
  });
});
