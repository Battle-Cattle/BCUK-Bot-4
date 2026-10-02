import { describe, it, expect } from 'vitest';
import { shouldSelfStop } from './subscribeOutcome';

describe('shouldSelfStop', () => {
  it('stops when nothing is desired', () => {
    expect(shouldSelfStop({ desired: 0, live: 0, transientFailures: 0 })).toBe(true);
  });

  it('stops when nothing is live and every failure was auth/scope', () => {
    expect(shouldSelfStop({ desired: 3, live: 0, transientFailures: 0 })).toBe(true);
  });

  it('keeps going when something is live', () => {
    expect(shouldSelfStop({ desired: 3, live: 1, transientFailures: 0 })).toBe(false);
  });

  it('keeps going (to retry) when nothing is live but some failures were transient', () => {
    expect(shouldSelfStop({ desired: 3, live: 0, transientFailures: 2 })).toBe(false);
  });
});
