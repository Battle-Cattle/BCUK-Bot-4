import { describe, it, expect } from 'vitest';
import {
  requireTrimmedString,
  normalizeCommandList,
  normalizeCommandInputs,
  isMysqlDuplicateEntryError,
  CommandNotFoundError,
  CommandConflictError,
} from './commandStringUtils';

describe('requireTrimmedString', () => {
  it('returns the trimmed string when valid', () => {
    expect(requireTrimmedString('  hello  ', 'field')).toBe('hello');
  });

  it('throws when the trimmed value is empty', () => {
    expect(() => requireTrimmedString('   ', 'name')).toThrow('Missing name');
    expect(() => requireTrimmedString('', 'name')).toThrow('Missing name');
  });

  it('throws when the string exceeds maxLength', () => {
    expect(() => requireTrimmedString('toolong', 'label', 4)).toThrow('exceeds maximum length of 4');
  });

  it('accepts a string exactly at maxLength', () => {
    expect(requireTrimmedString('abcd', 'label', 4)).toBe('abcd');
  });

  it('does not enforce maxLength when not provided', () => {
    expect(requireTrimmedString('a'.repeat(1000), 'label')).toHaveLength(1000);
  });
});

describe('normalizeCommandList', () => {
  it('lowercases and trims each command', () => {
    expect(normalizeCommandList(['  !Foo ', '!BAR'])).toEqual(['!foo', '!bar']);
  });

  it('filters out blank entries after trimming', () => {
    expect(normalizeCommandList(['!cmd', '   ', ''])).toEqual(['!cmd']);
  });

  it('accepts a single string and wraps it in an array', () => {
    expect(normalizeCommandList('!cmd')).toEqual(['!cmd']);
  });

  it('returns an empty array when all entries are blank', () => {
    expect(normalizeCommandList(['  ', ''])).toEqual([]);
  });
});

describe('normalizeCommandInputs', () => {
  it('deduplicates commands that are equal after normalization', () => {
    expect(normalizeCommandInputs(['!foo', '!FOO', '  !foo  '])).toEqual(['!foo']);
  });

  it('preserves order for non-duplicates', () => {
    expect(normalizeCommandInputs(['!b', '!a'])).toEqual(['!b', '!a']);
  });

  it('deduplicates while filtering blanks', () => {
    expect(normalizeCommandInputs(['!a', '', '!a'])).toEqual(['!a']);
  });
});

describe('isMysqlDuplicateEntryError', () => {
  it('returns true for an object with code ER_DUP_ENTRY', () => {
    expect(isMysqlDuplicateEntryError({ code: 'ER_DUP_ENTRY' })).toBe(true);
  });

  it('returns true for an object with errno 1062', () => {
    expect(isMysqlDuplicateEntryError({ errno: 1062 })).toBe(true);
  });

  it('returns false for non-MySQL errors', () => {
    expect(isMysqlDuplicateEntryError(new Error('generic'))).toBe(false);
    expect(isMysqlDuplicateEntryError({ code: 'ER_NO_SUCH_TABLE' })).toBe(false);
    expect(isMysqlDuplicateEntryError({ errno: 1064 })).toBe(false);
  });

  it('returns false for null, undefined, and primitives', () => {
    expect(isMysqlDuplicateEntryError(null)).toBe(false);
    expect(isMysqlDuplicateEntryError(undefined)).toBe(false);
    expect(isMysqlDuplicateEntryError('string')).toBe(false);
    expect(isMysqlDuplicateEntryError(1062)).toBe(false);
  });
});

describe('CommandNotFoundError', () => {
  it('has the correct name and message', () => {
    const err = new CommandNotFoundError(42);
    expect(err.name).toBe('CommandNotFoundError');
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
