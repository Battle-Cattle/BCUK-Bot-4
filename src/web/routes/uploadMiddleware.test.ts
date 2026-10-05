import { describe, it, expect, vi, afterEach } from 'vitest';
import multer from 'multer';
import fs from 'fs';
import type { Request, Response } from 'express';

vi.mock('./viewHelpers', () => ({ requireStreamer: vi.fn() }));
vi.mock('./errorHandling', () => ({ logAndRedirectError: vi.fn() }));

import { createMulterErrorRedirectHandler, writeFileOrCleanup, makeRequireStreamerBeforeUpload } from './uploadMiddleware';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

describe('createMulterErrorRedirectHandler', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  function mockLog() {
    const error = vi.fn();
    return { log: { error } as unknown as import('winston').Logger, error };
  }

  it('returns false and does not redirect when there is no error', () => {
    const { log } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/sfx', log, 'SFX upload middleware error:');
    expect(handler(null, res)).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects oversized files to file_too_large without logging', () => {
    const { log, error } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/sfx', log, 'SFX upload middleware error:');
    const err = new multer.MulterError('LIMIT_FILE_SIZE', 'sound');
    expect(handler(err, res)).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/sfx?error=file_too_large');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs and redirects other errors to upload_failed, using the caller-supplied basePath and log label', () => {
    const { log, error } = mockLog();
    const { res, redirect } = mockRes();
    const handler = createMulterErrorRedirectHandler('/overlay/settings', log, 'Overlay upload middleware error:');
    const err = new Error('boom');
    expect(handler(err, res)).toBe(true);
    expect(error).toHaveBeenCalledWith('Overlay upload middleware error:', err);
    expect(redirect).toHaveBeenCalledWith('/overlay/settings?error=upload_failed');
  });
});

describe('writeFileOrCleanup', () => {
  const log = { error: vi.fn() } as any;
  afterEach(() => { vi.restoreAllMocks(); log.error.mockReset(); });

  it('writes the file', async () => {
    const write = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    const rm = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    await writeFileOrCleanup('/tmp/x', Buffer.from('a'), log);
    expect(write).toHaveBeenCalledWith('/tmp/x', Buffer.from('a'));
    expect(rm).not.toHaveBeenCalled();
  });

  it('removes the partial file and rethrows the write error', async () => {
    const err = new Error('ENOSPC');
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(err);
    const rm = vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    await expect(writeFileOrCleanup('/tmp/x', Buffer.from('a'), log)).rejects.toBe(err);
    expect(rm).toHaveBeenCalledWith('/tmp/x', { force: true });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a failed cleanup and still rethrows the original write error', async () => {
    const err = new Error('ENOSPC');
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(err);
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(new Error('EACCES'));
    await expect(writeFileOrCleanup('/tmp/x', Buffer.from('a'), log)).rejects.toBe(err);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('/tmp/x'), expect.any(Error));
  });
});

describe('makeRequireStreamerBeforeUpload', () => {
  const log = { error: vi.fn() } as any;
  const middleware = makeRequireStreamerBeforeUpload({
    notAStreamerRedirect: '/x/settings?error=not_a_streamer', basePath: '/x/settings', log, logLabel: 'Check error:',
  });
  const res = () => ({ redirect: vi.fn() }) as unknown as Response;

  it('calls next() for a streamer', async () => {
    vi.mocked(requireStreamer).mockResolvedValueOnce({ id: 1 } as any);
    const next = vi.fn();
    await middleware({} as Request, res(), next);
    expect(next).toHaveBeenCalled();
    expect(requireStreamer).toHaveBeenCalledWith(expect.anything(), expect.anything(), '/x/settings?error=not_a_streamer');
  });

  it('does not call next() for a non-streamer (requireStreamer has redirected)', async () => {
    vi.mocked(requireStreamer).mockResolvedValueOnce(null);
    const next = vi.fn();
    await middleware({} as Request, res(), next);
    expect(next).not.toHaveBeenCalled();
  });

  it('redirects with upload_failed when the lookup throws', async () => {
    vi.mocked(requireStreamer).mockRejectedValueOnce(new Error('db down'));
    const next = vi.fn();
    const r = res();
    await middleware({} as Request, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(logAndRedirectError).toHaveBeenCalledWith(expect.objectContaining({
      res: r, log, logLabel: 'Check error:', basePath: '/x/settings', errorCode: 'upload_failed', err: expect.any(Error),
    }));
  });
});
