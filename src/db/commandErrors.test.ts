import { describe, it, expect } from 'vitest';
import { CommandNotFoundError, CommandSelfServiceDeniedError, CommandConflictError } from './commandErrors';

describe('CommandNotFoundError', () => {
  it('has the correct name and message', () => {
    const err = new CommandNotFoundError(42);
    expect(err.name).toBe('CommandNotFoundError');
    expect(err.message).toContain('42');
  });
});

describe('CommandSelfServiceDeniedError', () => {
  it('has the correct name and message', () => {
    const err = new CommandSelfServiceDeniedError(42);
    expect(err.name).toBe('CommandSelfServiceDeniedError');
    expect(err.message).toContain('42');
  });
});

describe('CommandConflictError', () => {
  it('includes all conflicting command names in the message', () => {
    const err = new CommandConflictError(['!a', '!b']);
    expect(err.name).toBe('CommandConflictError');
    expect(err.message).toContain('!a');
    expect(err.message).toContain('!b');
    expect(err.commands).toEqual(['!a', '!b']);
  });
});
