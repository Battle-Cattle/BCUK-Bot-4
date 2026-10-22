import { describe, it, expect } from 'vitest';
import { hasCommandPrefix } from './commandPrefix';

describe('hasCommandPrefix', () => {
  it.each(['!clap', '#blameandy', '!', '#'])('accepts %s', (text) => {
    expect(hasCommandPrefix(text)).toBe(true);
  });

  it.each(['hello', '?help', '@user', '9b964edf', ''])('rejects %o', (text) => {
    expect(hasCommandPrefix(text)).toBe(false);
  });
});
