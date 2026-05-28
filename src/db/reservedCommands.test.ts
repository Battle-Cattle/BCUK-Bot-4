import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_COMMANDS,
  RESERVED_BUILT_IN_COMMANDS,
  ReservedCommandError,
  assertNotReservedCommand,
} from './reservedCommands';

describe('RESERVED_BUILT_IN_COMMANDS', () => {
  it('contains every key from BUILT_IN_COMMANDS', () => {
    for (const key of Object.keys(BUILT_IN_COMMANDS)) {
      expect(RESERVED_BUILT_IN_COMMANDS.has(key)).toBe(true);
    }
  });
});

describe('assertNotReservedCommand', () => {
  it('throws ReservedCommandError for !multi', () => {
    expect(() => assertNotReservedCommand('!multi')).toThrow(ReservedCommandError);
  });

  it('throws ReservedCommandError for !so', () => {
    expect(() => assertNotReservedCommand('!so')).toThrow(ReservedCommandError);
  });

  it('is case-insensitive — !MULTI throws', () => {
    expect(() => assertNotReservedCommand('!MULTI')).toThrow(ReservedCommandError);
  });

  it('trims whitespace before checking — " !multi " throws', () => {
    expect(() => assertNotReservedCommand(' !multi ')).toThrow(ReservedCommandError);
  });

  it('does not throw for a non-reserved command', () => {
    expect(() => assertNotReservedCommand('!clap')).not.toThrow();
  });

  it('does not throw for an empty string', () => {
    expect(() => assertNotReservedCommand('')).not.toThrow();
  });

  it('error message includes the normalized trigger', () => {
    expect(() => assertNotReservedCommand('!multi')).toThrow("'!multi'");
  });

  it('error name is ReservedCommandError', () => {
    try {
      assertNotReservedCommand('!so');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as ReservedCommandError).name).toBe('ReservedCommandError');
    }
  });
});
