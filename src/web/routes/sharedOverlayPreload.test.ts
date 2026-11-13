import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { mockLogger } from '../../test-utils/loggerMock';
import { waitFor } from '../../test-utils/waitFor';

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/shared-preload-${process.pid}-${Date.now()}`);
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
// 1 KB/s: the quarter-second bucket holds one 16 KB slice, so a big file is slow but small ones pass.
vi.mock('../../shared/config', () => ({ OVERLAY_FOLDER: dir, SHARED_OVERLAY_PRELOAD_KB_PER_SECOND: 1 }));

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import supertest from 'supertest';
import { servePreloadVideo, parseByteRange, preloadBudget } from './sharedOverlayPreload';

const content = Buffer.from(Array.from({ length: 1000 }, (_v, i) => i % 251));

beforeAll(() => {
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shared', 'small.webm'), content);
  fs.writeFileSync(path.join(dir, 'shared', 'empty.webm'), '');
  fs.writeFileSync(path.join(dir, 'shared', 'big.webm'), Buffer.alloc(400 * 1024, 1));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// A generous limiter in front of the handler, as route handlers that read files are expected to have
// one (the real route sits behind the app's limiters); it never trips in these tests.
const testLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10_000, standardHeaders: false, legacyHeaders: false });
const app = () => {
  const a = express();
  a.get('/videos/:filename', testLimiter, servePreloadVideo);
  return a;
};
const get = (name: string, range?: string) => {
  const req = supertest(app()).get(`/videos/${name}`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return range ? req.set('Range', range) : req;
};

describe('parseByteRange', () => {
  it.each([
    [undefined, null],
    ['bytes=10-19', { start: 10, end: 19 }],
    ['bytes=990-', { start: 990, end: 999 }],
    ['bytes=-5', { start: 995, end: 999 }],
    ['bytes=0-99999', { start: 0, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
  ])('parses %s', (header, expected) => {
    expect(parseByteRange(header, 1000)).toEqual(expected);
  });

  it.each(['bytes=5000-', 'bytes=20-10', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=a-b'])('rejects %s', (header) => {
    expect(parseByteRange(header, 1000)).toBe('invalid');
  });
});

describe('servePreloadVideo', () => {
  it('sends the whole file with range headers when no Range is asked for', async () => {
    const res = await get('small.webm');
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('1000');
    expect(res.headers['content-type']).toBe('video/webm');
    expect(Buffer.from(res.body).equals(content)).toBe(true);
  });

  it('returns exactly the requested bytes for a range', async () => {
    const res = await get('small.webm', 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 10-19/1000');
    expect(res.headers['content-length']).toBe('10');
    expect(Buffer.from(res.body).equals(content.subarray(10, 20))).toBe(true);
  });

  it('supports open-ended and suffix ranges', async () => {
    expect(Buffer.from((await get('small.webm', 'bytes=990-')).body).equals(content.subarray(990))).toBe(true);
    expect(Buffer.from((await get('small.webm', 'bytes=-5')).body).equals(content.subarray(995))).toBe(true);
  });

  it('answers 416 with the size for an unsatisfiable range', async () => {
    const res = await get('small.webm', 'bytes=5000-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
  });

  it('sends an empty file as an empty 200', async () => {
    const res = await get('empty.webm');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
  });

  it('answers 404 when the file vanishes between the checks and reading its size', async () => {
    const stat = vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect((await get('small.webm')).status).toBe(404);
    stat.mockRestore();
  });

  it('refuses unsafe or unsupported names and 404s a missing file', async () => {
    expect((await get('..%2Fsmall.webm')).status).toBe(400);
    expect((await get('small.mp4')).status).toBe(400);
    expect((await get('missing.webm')).status).toBe(404);
  });

  it('stops reading and gives up its share of the budget when the client goes away', async () => {
    const server = http.createServer(app());
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    const { port } = server.address() as AddressInfo;
    const received = await new Promise<number>((resolve) => {
      const req = http.get({ port, path: '/videos/big.webm' }, (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.length;
          if (bytes > 0) { req.destroy(); resolve(bytes); }
        });
      });
      req.on('error', () => {});
    });
    expect(received).toBeGreaterThan(0);
    await waitFor(() => { expect(preloadBudget.pending()).toBe(0); });
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });
});
