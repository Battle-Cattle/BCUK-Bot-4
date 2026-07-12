import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

// Isolates this test from the real DB module — required at runtime only by shared.ts's
// requireStreamer/handleReservedOrConflictCommandError, neither of which this file uses,
// but a real (unmocked) import would otherwise try to build a live connection pool.
vi.mock('../../db', () => ({}));

import {
  STREAMS_ERROR_CODES,
  STREAMS_ERROR_MESSAGES,
  redirectStreamsInvalid,
  redirectStreamsFailure,
} from './streamsErrors';

function mockRes() {
  const redirect = vi.fn();
  return { res: { redirect } as unknown as Response, redirect };
}

function mockLog() {
  const error = vi.fn();
  return { log: { error } as unknown as import('winston').Logger, error };
}

describe('STREAMS_ERROR_MESSAGES', () => {
  it('has exactly one message per code in STREAMS_ERROR_CODES', () => {
    expect(Object.keys(STREAMS_ERROR_MESSAGES).sort()).toEqual([...STREAMS_ERROR_CODES].sort());
  });
});

describe('redirectStreamsInvalid', () => {
  it('redirects to the streams page with the given error code', () => {
    const { res, redirect } = mockRes();
    redirectStreamsInvalid(res, 'missing_fields');
    expect(redirect).toHaveBeenCalledWith('/admin/streams?error=missing_fields');
  });
});

describe('redirectStreamsFailure', () => {
  it('logs the error with the given label and redirects with the error code', () => {
    const { res, redirect } = mockRes();
    const { log, error } = mockLog();
    const err = new Error('boom');

    redirectStreamsFailure(res, log, 'Add stream group error:', err, 'add_group_failed');

    expect(error).toHaveBeenCalledWith('Add stream group error:', err);
    expect(redirect).toHaveBeenCalledWith('/admin/streams?error=add_group_failed');
  });
});
