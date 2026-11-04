import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkedUploadStore, isUploadId, parseDeclaration } from './chunkedUploadStore';

let dir: string;
let clock: number;
let store: ChunkedUploadStore;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chunked-upload-'));
  clock = Date.now();
  store = new ChunkedUploadStore({ dir, maxBytes: 10, ttlMs: 60_000, now: () => clock });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function startUpload(owner = 'u1', size = 6): Promise<string> {
  const result = await store.start(owner, { name: 'clip.webm', size, type: 'video/webm' });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}

describe('parseDeclaration', () => {
  it('accepts a name, numeric size and type, keeping only the base name', () => {
    expect(parseDeclaration({ name: '../x/clip.mov', size: '12', type: 'video/quicktime' }))
      .toEqual({ name: 'clip.mov', size: 12, type: 'video/quicktime' });
  });

  it('rejects missing names and non-positive or fractional sizes', () => {
    expect(parseDeclaration({ name: '', size: 1 })).toBeNull();
    expect(parseDeclaration({ name: 'a', size: 0 })).toBeNull();
    expect(parseDeclaration({ name: 'a', size: 1.5 })).toBeNull();
    expect(parseDeclaration(null)).toBeNull();
  });
});

describe('isUploadId', () => {
  it('accepts only UUIDs', () => {
    expect(isUploadId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isUploadId('../etc/passwd')).toBe(false);
  });
});

describe('ChunkedUploadStore', () => {
  it('assembles pieces sent in order and hands the file over on finish', async () => {
    const id = await startUpload();
    expect(await store.append('u1', id, 0, Buffer.from('abc'))).toEqual({ ok: true, received: 3 });
    expect(await store.append('u1', id, 3, Buffer.from('def'))).toEqual({ ok: true, received: 6 });
    const done = await store.finish('u1', id);
    if (!done.ok) throw new Error(done.error);
    expect(await fs.promises.readFile(done.path, 'utf8')).toBe('abcdef');
    expect(done).toMatchObject({ name: 'clip.webm', size: 6, type: 'video/webm' });
    expect(await store.status('u1', id)).toEqual({ ok: false, error: 'not_found' });
  });

  it('reports the confirmed offset so a client can resume', async () => {
    const id = await startUpload();
    await store.append('u1', id, 0, Buffer.from('abcd'));
    expect(await store.status('u1', id)).toEqual({ ok: true, received: 4, size: 6 });
  });

  it('rejects out-of-order and overlapping pieces with the confirmed offset', async () => {
    const id = await startUpload();
    await store.append('u1', id, 0, Buffer.from('abc'));
    expect(await store.append('u1', id, 5, Buffer.from('f'))).toEqual({ ok: false, error: 'bad_offset', received: 3 });
    expect(await store.append('u1', id, 1, Buffer.from('bcd'))).toEqual({ ok: false, error: 'bad_offset', received: 3 });
  });

  it('serialises concurrent pieces at the same offset so only one lands', async () => {
    const id = await startUpload();
    const results = await Promise.all([
      store.append('u1', id, 0, Buffer.from('abc')),
      store.append('u1', id, 0, Buffer.from('xyz')),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await store.status('u1', id)).toEqual({ ok: true, received: 3, size: 6 });
  });

  it('rejects a declared size over the limit and pieces past the declared size', async () => {
    expect(await store.start('u1', { name: 'a', size: 11, type: '' })).toEqual({ ok: false, error: 'file_too_large' });
    const id = await startUpload('u1', 2);
    expect(await store.append('u1', id, 0, Buffer.from('abc'))).toEqual({ ok: false, error: 'file_too_large' });
  });

  it("treats another user's upload ID as missing", async () => {
    const id = await startUpload('u1');
    expect(await store.status('u2', id)).toEqual({ ok: false, error: 'not_found' });
    expect(await store.append('u2', id, 0, Buffer.from('a'))).toEqual({ ok: false, error: 'not_found' });
    expect((await store.finish('u2', id)).ok).toBe(false);
    expect(await store.cancel('u2', id)).toBe(false);
  });

  it('rejects malformed upload IDs', async () => {
    expect(await store.status('u1', '../x')).toEqual({ ok: false, error: 'not_found' });
  });

  it('allows one upload per user at a time, naming the active one', async () => {
    const id = await startUpload('u1');
    expect(await store.start('u1', { name: 'b', size: 1, type: '' })).toEqual({ ok: false, error: 'upload_busy', activeId: id });
    expect((await store.start('u2', { name: 'b', size: 1, type: '' })).ok).toBe(true);
    expect(await store.cancel('u1', id)).toBe(true);
    expect((await store.start('u1', { name: 'b', size: 1, type: '' })).ok).toBe(true);
  });

  it('refuses to finish an incomplete upload', async () => {
    const id = await startUpload();
    await store.append('u1', id, 0, Buffer.from('ab'));
    expect(await store.finish('u1', id)).toEqual({ ok: false, error: 'incomplete', received: 2 });
  });

  it('expires idle sessions and sweeps their files', async () => {
    const id = await startUpload();
    clock += 120_000;
    expect(await store.status('u1', id)).toEqual({ ok: false, error: 'not_found' });
    expect(await store.append('u1', id, 0, Buffer.from('a'))).toEqual({ ok: false, error: 'not_found' });
    expect((await store.start('u1', { name: 'b', size: 1, type: '' })).ok).toBe(true);
    await store.sweep();
    expect((await fs.promises.readdir(dir)).filter((n) => n.startsWith(id))).toEqual([]);
  });

  it('keeps a session alive while pieces keep arriving', async () => {
    const id = await startUpload();
    clock += 50_000;
    await store.append('u1', id, 0, Buffer.from('abc'));
    clock += 50_000;
    await store.sweep();
    expect(await store.status('u1', id)).toEqual({ ok: true, received: 3, size: 6 });
  });
});

describe('ChunkedUploadStore without its folder or with failing removals', () => {
  it('starts in a folder that does not exist yet, and sweeps nothing there', async () => {
    const fresh = new ChunkedUploadStore({ dir: path.join(dir, 'missing'), maxBytes: 10 });
    await fresh.sweep();
    expect((await fresh.start('u1', { name: 'a', size: 1, type: '' })).ok).toBe(true);
  });

  it('logs instead of throwing when a session file cannot be removed or swept', async () => {
    const id = await startUpload();
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('EBUSY'));
    expect(await store.cancel('u1', id)).toBe(true);
    clock += 120_000;
    await expect(store.sweep()).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalled();
  });
});
