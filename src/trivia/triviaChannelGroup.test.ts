import { describe, it, expect, beforeEach } from 'vitest';
import {
  setChannelGroupKey,
  getChannelsInGroup,
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

describe('getChannelsInGroup', () => {
  it('returns an empty array for a group nothing has joined', () => {
    expect(getChannelsInGroup('nobody-here')).toEqual([]);
  });

  it('returns every channel recorded under the same group key', () => {
    setChannelGroupKey('channela', 'guild-1');
    setChannelGroupKey('channelb', 'guild-1');
    setChannelGroupKey('channelc', 'guild-2');

    expect(getChannelsInGroup('guild-1').sort()).toEqual(['channela', 'channelb']);
    expect(getChannelsInGroup('guild-2')).toEqual(['channelc']);
  });

  it('excludes a channel after it moves to a different group', () => {
    setChannelGroupKey('channela', 'guild-1');
    setChannelGroupKey('channela', 'guild-2');

    expect(getChannelsInGroup('guild-1')).toEqual([]);
    expect(getChannelsInGroup('guild-2')).toEqual(['channela']);
  });
});
