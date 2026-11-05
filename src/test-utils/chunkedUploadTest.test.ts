import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  FakeChunkedUploadStore, fakeToMemoryFile, mockChunkedUploadRoutesModule, mockChunkedUploadStoreModule, uploadRequest,
} from './chunkedUploadTest';

/** An app whose start/complete routes echo what the upload helper sent. */
function echoApp(startStatus = 200) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post('/up/start', (req, res) => {
    if (startStatus !== 200) {
      res.status(startStatus).json({ error: 'file_too_large' });
      return;
    }
    res.json({ id: 'abc', declared: req.body });
  });
  app.post('/up/:id/complete', (req, res) => {
    res.json({ id: req.params.id, fields: req.body, header: req.get('x-test') ?? null });
  });
  return app;
}

describe('FakeChunkedUploadStore', () => {
  it('refuses an oversized start and finishes only uploads it knows', async () => {
    const store = new FakeChunkedUploadStore({ dir: '/unused', maxBytes: 4 });
    expect(await store.start('u', { name: 'a', size: 5, type: '' })).toEqual({ ok: false, error: 'file_too_large' });
    const started = (await store.start('u', { name: 'a', size: 2, type: 'x' })) as { ok: true; id: string };
    expect(started.ok).toBe(true);
    // No bytes were registered for it, so it can't finish.
    expect(await store.finish('u', started.id)).toEqual({ ok: false, error: 'not_found' });
    expect(await store.status()).toEqual({ ok: false, error: 'not_found' });
    expect(await store.append()).toEqual({ ok: false, error: 'not_found' });
    expect(await store.cancel()).toBe('not_found');
    await expect(store.sweep()).resolves.toBeUndefined();
  });
});

describe('fakeToMemoryFile', () => {
  it('hands over an empty buffer for an upload with no registered bytes', async () => {
    const file = await fakeToMemoryFile({ path: 'missing', name: 'a.png', size: 0, type: 'image/png' }, 'image');
    expect(file).toMatchObject({ fieldname: 'image', originalname: 'a.png', mimetype: 'image/png', size: 0 });
    expect(file.buffer).toEqual(Buffer.alloc(0));
  });
});

describe('module mocks', () => {
  it('swap in the fakes and keep everything else', () => {
    const store = mockChunkedUploadStoreModule({ other: 1, ChunkedUploadStore: null });
    expect(store).toEqual({ other: 1, ChunkedUploadStore: FakeChunkedUploadStore });
    const routes = mockChunkedUploadRoutesModule({ other: 2, toMemoryFile: null });
    expect(routes).toEqual({ other: 2, toMemoryFile: fakeToMemoryFile });
  });
});

describe('uploadRequest', () => {
  it('starts with the declared file, then completes with the fields and headers', async () => {
    const res = await uploadRequest(echoApp()).post('/up').set('X-Test', 'yes').field('name', 'Clip').attach('video', Buffer.from('abc'), 'clip.webm');
    expect(res.body).toEqual({ id: 'abc', fields: { name: 'Clip' }, header: 'yes' });
  });

  it('returns a refused start as it is', async () => {
    const res = await uploadRequest(echoApp(413)).post('/up').attach('video', Buffer.from('abc'));
    expect(res.status).toBe(413);
  });

  it('completes an unknown upload when no file was attached', async () => {
    const res = await uploadRequest(echoApp()).post('/up');
    expect(res.body.id).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('checks the status with expect, and rejects a mismatch', async () => {
    await expect(uploadRequest(echoApp()).post('/up').expect(200)).resolves.toMatchObject({ status: 200 });
    await expect(uploadRequest(echoApp()).post('/up').expect(302)).rejects.toThrow('expected 302, got 200');
  });

  it('passes a failure to the rejection handler', async () => {
    const failing = uploadRequest(express().use((req) => { req.socket.destroy(); })).post('/up').attach('video', Buffer.from('a'));
    await expect(failing.then(() => 'ok', () => 'rejected')).resolves.toBe('rejected');
  });
});
