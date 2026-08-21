import { describe, it, expect, vi } from 'vitest';
import multer from 'multer';
import type { Response } from 'express';
import { createMulterErrorRedirectHandler } from './uploadMiddleware';

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
