import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./commandStringUtils', () => ({
  CommandConflictError: class CommandConflictError extends Error {
    constructor(cmds: string[]) {
      super(String(cmds));
    }
  },
  normalizeCommandInputs: vi.fn(),
  buildInClausePlaceholders: vi.fn(),
}));

import { isDeadlockError, getCommandWriteLockName } from './commandLocks';

describe('isDeadlockError', () => {
  it('returns true when code is ER_LOCK_DEADLOCK', () => {
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
  });

  it('returns true when errno is 1213', () => {
    expect(isDeadlockError({ errno: 1213 })).toBe(true);
  });

  it('returns true when both code and errno indicate a deadlock', () => {
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 })).toBe(true);
  });

  it('returns false for a different error code', () => {
    expect(isDeadlockError({ code: 'ER_OTHER' })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isDeadlockError({})).toBe(false);
  });

  it('throws when passed null (cannot read properties of null)', () => {
    expect(() => isDeadlockError(null)).toThrow();
  });

  it('throws when passed undefined (cannot read properties of undefined)', () => {
    expect(() => isDeadlockError(undefined)).toThrow();
  });

  it('returns false for a plain string', () => {
    expect(isDeadlockError('ER_LOCK_DEADLOCK')).toBe(false);
  });
});

describe('getCommandWriteLockName', () => {
  it('returns a string that starts with bcuk_cmd_', () => {
    const lockName = getCommandWriteLockName('!test');
    expect(lockName.startsWith('bcuk_cmd_')).toBe(true);
  });

  it('is deterministic — same input always returns the same string', () => {
    const first = getCommandWriteLockName('!clap');
    const second = getCommandWriteLockName('!clap');
    expect(first).toBe(second);
  });

  it('total length is at most 64 characters (MySQL named lock limit)', () => {
    const lockName = getCommandWriteLockName('!some-very-long-command-trigger-string');
    expect(lockName.length).toBeLessThanOrEqual(64);
  });

  it('different commands produce different lock names', () => {
    const a = getCommandWriteLockName('!clap');
    const b = getCommandWriteLockName('!hug');
    expect(a).not.toBe(b);
  });

  it('the hash portion after bcuk_cmd_ is exactly 48 hex characters', () => {
    const lockName = getCommandWriteLockName('!test');
    const prefix = 'bcuk_cmd_';
    const hashPart = lockName.slice(prefix.length);
    expect(hashPart).toHaveLength(48);
    expect(hashPart).toMatch(/^[0-9a-f]{48}$/);
  });
});
