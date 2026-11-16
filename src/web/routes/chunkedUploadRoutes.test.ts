import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';
import type { UploadedFile } from '../uploadedFile';
import supertest from 'supertest';
import { mockLogger } from '../../test-utils/loggerMock';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { ChunkedUploadStore, CHUNK_MAX_BYTES } from '../chunkedUploadStore';
import {
  mountChunkedUploadRoutes, parseOffset, toMemoryFile, CHUNKED_UPLOAD_SWEEP_INTERVAL_MS, type ChunkedUploadRouteOptions,
} from './chunkedUploadRoutes';

let dir: string;
let store: ChunkedUploadStore;
let received: { file?: UploadedFile; body?: unknown };
const checkStart = vi.fn<NonNullable<ChunkedUploadRouteOptions['checkStart']>>(() => null);

function makeApp(user: unknown = { discordId: 'u1' }, toFile: ChunkedUploadRouteOptions['toFile'] = toMemoryFile) {
  const router = Router();
  mountChunkedUploadRoutes(router, {
    path: '/upload',
    store,
    guards: [],
    field: 'sound',
    checkStart,
    toFile,
    complete: [(req: Request, res: Response) => {
      received = { file: req.file, body: req.body };
      res.redirect('/page?success=uploaded');
    }],
    basePath: '/page',
    log: mockLogger() as never,
  });
  return supertest(buildTestApp({ router, bodyParser: 'both', sessionUser: user }));
}

async function start(app: ReturnType<typeof makeApp>, size = 6): Promise<string> {
  const res = await app.post('/upload/start').send({ name: 'clip.mp3', size, type: 'audio/mpeg' });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

function put(app: ReturnType<typeof makeApp>, id: string, offset: number | string, data: string) {
  return app.put(`/upload/${id}/chunk?offset=${offset}`).set('Content-Type', 'application/octet-stream').send(Buffer.from(data));
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chunked-routes-'));
  store = new ChunkedUploadStore({ dir, maxBytes: 10 });
  received = {};
  checkStart.mockReset();
  checkStart.mockReturnValue(null);
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('parseOffset', () => {
  it('accepts whole non-negative numbers only', () => {
    expect(parseOffset('0')).toBe(0);
    expect(parseOffset('42')).toBe(42);
    expect(parseOffset('-1')).toBeNull();
    expect(parseOffset('1.5')).toBeNull();
    expect(parseOffset(undefined)).toBeNull();
  });
});

describe('mountChunkedUploadRoutes', () => {
  it('runs a whole upload and hands the area handler a req.file plus the form fields', async () => {
    const app = makeApp();
    const id = await start(app);
    expect((await put(app, id, 0, 'abc')).body).toEqual({ received: 3 });
    expect((await app.get(`/upload/${id}`)).body).toEqual({ received: 3, size: 6 });
    expect((await put(app, id, 3, 'def')).body).toEqual({ received: 6 });
    const done = await app.post(`/upload/${id}/complete`).type('form').send({ name: 'Clap' });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/page?success=uploaded');
    expect(received.file?.buffer.toString()).toBe('abcdef');
    expect(received.file).toMatchObject({ fieldname: 'sound', originalname: 'clip.mp3', mimetype: 'audio/mpeg', size: 6 });
    expect(received.body).toEqual({ name: 'Clap' });
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('tells the client the piece size on start', async () => {
    const res = await makeApp().post('/upload/start').send({ name: 'a', size: 1 });
    expect(res.body.chunkSize).toBe(CHUNK_MAX_BYTES);
  });

  it('rejects a malformed declaration, an oversized one and a refused per-area check', async () => {
    const app = makeApp();
    expect((await app.post('/upload/start').send({ name: '', size: 1 })).status).toBe(400);
    expect((await app.post('/upload/start').send({ name: 'a', size: 11 })).status).toBe(413);
    checkStart.mockReturnValue('transcode_busy');
    const refused = await app.post('/upload/start').send({ name: 'a', size: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'transcode_busy' });
  });

  it('gives the per-area check the declaration and the request, and waits for an asynchronous answer', async () => {
    checkStart.mockImplementation(async (_declared, req) => (req.session.user?.discordId === 'u1' ? 'storage_limit' : null));
    const refused = await makeApp().post('/upload/start').send({ name: 'a', size: 1, type: 'video/webm' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'storage_limit' });
    expect(checkStart.mock.calls[0]![0]).toEqual({ name: 'a', size: 1, type: 'video/webm' });
    expect((await makeApp({ discordId: 'u2' }).post('/upload/start').send({ name: 'a', size: 1 })).status).toBe(200);
  });

  it('answers 500 when the per-area check fails', async () => {
    checkStart.mockRejectedValue(new Error('db down'));
    expect((await makeApp().post('/upload/start').send({ name: 'a', size: 1 })).status).toBe(500);
  });

  it('refuses a second upload by the same user, naming the first', async () => {
    const app = makeApp();
    const id = await start(app);
    const second = await app.post('/upload/start').send({ name: 'b', size: 1 });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'upload_busy', activeId: id });
  });

  it('rejects out-of-order pieces with the offset to resume from', async () => {
    const app = makeApp();
    const id = await start(app);
    await put(app, id, 0, 'abc');
    const gap = await put(app, id, 4, 'e');
    expect(gap.status).toBe(409);
    expect(gap.body).toEqual({ error: 'bad_offset', received: 3 });
    expect((await put(app, id, 'x', 'e')).status).toBe(409);
  });

  it("answers 404 for another user's upload", async () => {
    const id = await start(makeApp());
    const other = makeApp({ discordId: 'u2' });
    expect((await other.get(`/upload/${id}`)).status).toBe(404);
    expect((await put(other, id, 0, 'a')).status).toBe(404);
    expect((await other.delete(`/upload/${id}`)).status).toBe(404);
    const done = await other.post(`/upload/${id}/complete`);
    expect(done.headers.location).toBe('/page?error=upload_expired');
  });

  it('answers 401 without a logged-in user', async () => {
    expect((await makeApp(null).post('/upload/start').send({ name: 'a', size: 1 })).status).toBe(401);
  });

  it('redirects an incomplete upload instead of running the area handler', async () => {
    const app = makeApp();
    const id = await start(app);
    await put(app, id, 0, 'ab');
    const done = await app.post(`/upload/${id}/complete`);
    expect(done.headers.location).toBe('/page?error=upload_incomplete');
    expect(received.file).toBeUndefined();
  });

  it('cancels an upload so the user can start another', async () => {
    const app = makeApp();
    const id = await start(app);
    expect((await app.delete(`/upload/${id}`)).status).toBe(204);
    expect((await app.get(`/upload/${id}`)).status).toBe(404);
    await start(app);
  });

  it('answers 500 when the store fails unexpectedly', async () => {
    vi.spyOn(store, 'status').mockRejectedValue(new Error('disk gone'));
    const res = await makeApp().get('/upload/0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upload_failed' });
  });

  it('redirects with upload_failed when the finished file cannot be handed over', async () => {
    const app = makeApp({ discordId: 'u1' }, () => Promise.reject(new Error('read failed')));
    const id = await start(app, 1);
    await put(app, id, 0, 'a');
    const done = await app.post(`/upload/${id}/complete`);
    expect(done.headers.location).toBe('/page?error=upload_failed');
    expect(received.file).toBeUndefined();
  });

  it('answers 500 when a cancelled upload\'s files cannot be removed', async () => {
    vi.spyOn(store, 'cancel').mockResolvedValue('failed');
    const res = await makeApp().delete('/upload/0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upload_failed' });
  });
});

describe('periodic sweep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps each area's sessions and runs its extra cleanup on an interval", async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(store, 'sweep').mockResolvedValue();
    const onSweep = vi.fn().mockResolvedValue(undefined);
    mountChunkedUploadRoutes(Router(), {
      path: '/upload', store, guards: [], field: 'sound', toFile: toMemoryFile, complete: [], basePath: '/page',
      log: mockLogger() as never, onSweep,
    });
    await vi.advanceTimersByTimeAsync(CHUNKED_UPLOAD_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledOnce();
    expect(onSweep).toHaveBeenCalledOnce();
  });
});
