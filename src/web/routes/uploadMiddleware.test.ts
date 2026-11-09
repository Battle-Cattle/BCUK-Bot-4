import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import type { Request, Response } from 'express';

vi.mock('./viewHelpers', () => ({ requireStreamer: vi.fn() }));
vi.mock('./errorHandling', () => ({ logAndRedirectError: vi.fn() }));

import { writeFileOrCleanup, makeRequireStreamerBeforeUpload } from './uploadMiddleware';
import { requireStreamer } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';

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
