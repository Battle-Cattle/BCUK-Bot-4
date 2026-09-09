import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';

vi.mock('../../db', () => {
  class ReservedCommandError extends Error {}
  class CommandConflictError extends Error {}
  return {
    ReservedCommandError,
    CommandConflictError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
  };
});

import { ReservedCommandError, CommandConflictError, isMysqlDuplicateEntryError } from '../../db';
import { logAndRedirectError, handleReservedOrConflictCommandError, renderOrError } from './errorHandling';

describe('renderOrError', () => {
  function mockRes() {
    const render = vi.fn();
    const status = vi.fn().mockReturnThis();
    return { res: { render, status } as unknown as Response, render, status };
  }

  function mockLog() {
    const error = vi.fn();
    return { log: { error } as unknown as import('winston').Logger, error };
  }

  it('runs render and never touches the error path on success', async () => {
    const { res, render, status } = mockRes();
    const { log, error } = mockLog();
    const doRender = vi.fn().mockResolvedValue(undefined);

    await renderOrError({ res, log, logLabel: 'Widget page error:', sessionUser: undefined, errorMessage: 'Failed to load widgets.' }, doRender);

    expect(doRender).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('logs the error and renders the error view with a 500 status when render throws', async () => {
    const { res, render, status } = mockRes();
    const { log, error } = mockLog();
    const boom = new Error('boom');
    const doRender = vi.fn().mockRejectedValue(boom);

    await renderOrError({ res, log, logLabel: 'Widget page error:', sessionUser: undefined, errorMessage: 'Failed to load widgets.' }, doRender);

    expect(error).toHaveBeenCalledWith('Widget page error:', boom);
    expect(status).toHaveBeenCalledWith(500);
    expect(render).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Failed to load widgets.' }));
  });
});

describe('logAndRedirectError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  function mockLog() {
    const error = vi.fn();
    return { log: { error } as unknown as import('winston').Logger, error };
  }

  it('logs the error with the given label and forwards err unchanged', () => {
    const { res } = mockRes();
    const { log, error } = mockLog();
    const err = new Error('boom');
    logAndRedirectError({ res, log, logLabel: 'Add SFX category error:', err, basePath: '/sfx', errorCode: 'add_failed' });
    expect(error).toHaveBeenCalledWith('Add SFX category error:', err);
  });

  it('redirects to basePath with the error query param', () => {
    const { res, redirect } = mockRes();
    const { log } = mockLog();
    logAndRedirectError({ res, log, logLabel: 'Rename SFX category error:', err: new Error('x'), basePath: '/sfx', errorCode: 'update_failed' });
    expect(redirect).toHaveBeenCalledWith('/sfx?error=update_failed');
  });

  it('works with a non-Error thrown value', () => {
    const { res, redirect } = mockRes();
    const { log, error } = mockLog();
    logAndRedirectError({ res, log, logLabel: 'Remove error:', err: 'not an error object', basePath: '/counters', errorCode: 'remove_failed' });
    expect(error).toHaveBeenCalledWith('Remove error:', 'not an error object');
    expect(redirect).toHaveBeenCalledWith('/counters?error=remove_failed');
  });
});

describe('handleReservedOrConflictCommandError', () => {
  function mockRes() {
    const redirect = vi.fn();
    return { res: { redirect } as unknown as Response, redirect };
  }

  const OPTIONS = { basePath: '/commands', conflictErrorCode: 'command_taken' };

  it('redirects to basePath?error=reserved_command for a ReservedCommandError and returns true', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new ReservedCommandError('reserved'), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=reserved_command');
  });

  it('redirects to basePath?error=<conflictErrorCode> for a CommandConflictError and returns true', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new CommandConflictError(['conflict']), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=command_taken');
  });

  it('redirects to basePath?error=<conflictErrorCode> for a raw MySQL duplicate-entry error and returns true', () => {
    vi.mocked(isMysqlDuplicateEntryError).mockReturnValueOnce(true);
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new Error('ER_DUP_ENTRY'), res, OPTIONS);
    expect(handled).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/commands?error=command_taken');
  });

  it('returns false and does not redirect for an unrelated error', () => {
    const { res, redirect } = mockRes();
    const handled = handleReservedOrConflictCommandError(new Error('boom'), res, OPTIONS);
    expect(handled).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied basePath and conflictErrorCode', () => {
    const { res, redirect } = mockRes();
    handleReservedOrConflictCommandError(
      new CommandConflictError(['conflict']),
      res,
      { basePath: '/counters', conflictErrorCode: 'duplicate_command' },
    );
    expect(redirect).toHaveBeenCalledWith('/counters?error=duplicate_command');
  });
});
