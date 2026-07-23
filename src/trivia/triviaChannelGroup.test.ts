import { describe, it, expect, beforeEach } from 'vitest';
import {
  setChannelGroupKey,
  clearChannelGroupKey,
  resolveTriviaGroupKey,
  __resetTriviaChannelGroupForTests,
} from './triviaChannelGroup';

beforeEach(() => {
  __resetTriviaChannelGroupForTests();
});

describe('resolveTriviaGroupKey', () => {
  it("returns the channel's own login when nothing has been recorded for it", () => {
    expect(resolveTriviaGroupKey('neverconnected')).toBe('neverconnected');
  });

  it('returns the last group key recorded via setChannelGroupKey', () => {
    setChannelGroupKey('channela', 'guild-1');
    expect(resolveTriviaGroupKey('channela')).toBe('guild-1');
  });

  it('reflects the most recent write when set more than once', () => {
    setChannelGroupKey('channela', 'guild-1');
    setChannelGroupKey('channela', 'guild-2');
    expect(resolveTriviaGroupKey('channela')).toBe('guild-2');
  });
});

describe('clearChannelGroupKey', () => {
  it("falls back to the channel's own login after its group key is cleared", () => {
    setChannelGroupKey('channela', 'guild-1');
    clearChannelGroupKey('channela');
    expect(resolveTriviaGroupKey('channela')).toBe('channela');
  });

  it('does nothing (no throw) for a channel with no recorded group key', () => {
    expect(() => clearChannelGroupKey('neverconnected')).not.toThrow();
  });

  it('does not affect other channels', () => {
    setChannelGroupKey('channela', 'guild-1');
    setChannelGroupKey('channelb', 'guild-1');
    clearChannelGroupKey('channela');
    expect(resolveTriviaGroupKey('channelb')).toBe('guild-1');
  });
});
