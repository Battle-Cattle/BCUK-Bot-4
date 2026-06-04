import { describe, it, expect } from 'vitest';
import { extractCommand } from './commandUtils';

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
