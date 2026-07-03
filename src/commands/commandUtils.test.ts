import { describe, it, expect } from 'vitest';
import { extractCommand, extractArgs } from './commandUtils';

describe('extractCommand', () => {
  it('returns null for an empty string', () => {
    expect(extractCommand('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(extractCommand('   ')).toBeNull();
  });

  it('extracts the first token as lowercase', () => {
    expect(extractCommand('!Ding')).toBe('!ding');
  });

  it('ignores everything after the first whitespace', () => {
    expect(extractCommand('!so @friend extra args')).toBe('!so');
  });

  it('trims leading and trailing whitespace before splitting', () => {
    expect(extractCommand('  !cmd arg  ')).toBe('!cmd');
  });

  it('returns the full string lowercased when there is only one token', () => {
    expect(extractCommand('!321')).toBe('!321');
  });
});

describe('extractArgs', () => {
  it('returns an empty string for an empty message', () => {
    expect(extractArgs('')).toBe('');
  });

  it('returns an empty string for a whitespace-only message', () => {
    expect(extractArgs('   ')).toBe('');
  });

  it('returns an empty string when there are no args after the command', () => {
    expect(extractArgs('!ding')).toBe('');
  });

  it('returns the trimmed text after the first token for multiple words', () => {
    expect(extractArgs('!so @friend extra args')).toBe('@friend extra args');
  });

  it('trims extra leading/trailing whitespace around the args', () => {
    expect(extractArgs('  !cmd   arg1  arg2   ')).toBe('arg1  arg2');
  });

  it('preserves original casing of the args', () => {
    expect(extractArgs('!Cmd Hello World')).toBe('Hello World');
  });
});
