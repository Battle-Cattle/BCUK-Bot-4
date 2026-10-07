import { describe, it, expect } from 'vitest';
import {
  requireTrimmedString,
  normalizeCommand,
  normalizeCommandList,
  normalizeCommandInputs,
} from './commandStringUtils';

describe('normalizeCommand', () => {
  it('trims and lowercases a command string', () => {
    expect(normalizeCommand('  !Foo  ')).toBe('!foo');
  });

  it('returns null for an empty string', () => {
    expect(normalizeCommand('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizeCommand('   ')).toBeNull();
  });

  it('leaves an already-normalized command unchanged', () => {
    expect(normalizeCommand('!clap')).toBe('!clap');
  });
});

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
