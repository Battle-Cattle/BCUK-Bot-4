import { describe, it, expect, beforeEach } from 'vitest';
import { refreshStates, getRefreshState, forgetGuildRefreshState } from './guildRefreshState';

const GUILD_ID = '900000000000000001';

beforeEach(() => {
  refreshStates.clear();
});

describe('getRefreshState', () => {
  it('returns idle defaults for a guild with no recorded refresh', () => {
    expect(getRefreshState(GUILD_ID)).toEqual({
      outcome: 'idle',
      updatedCount: 0,
      failureCount: 0,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('returns the recorded state for a guild with one', () => {
    refreshStates.set(GUILD_ID, { outcome: 'success', updatedCount: 3, failureCount: 0, startedAt: 1, finishedAt: 2 });
    expect(getRefreshState(GUILD_ID)).toEqual({ outcome: 'success', updatedCount: 3, failureCount: 0, startedAt: 1, finishedAt: 2 });
  });
});

describe('forgetGuildRefreshState', () => {
  it("removes a guild's recorded refresh state, resetting it to idle on next read", () => {
    refreshStates.set(GUILD_ID, { outcome: 'success', updatedCount: 3, failureCount: 0, startedAt: 1, finishedAt: 2 });

    forgetGuildRefreshState(GUILD_ID);

    expect(getRefreshState(GUILD_ID)).toEqual({
      outcome: 'idle',
      updatedCount: 0,
      failureCount: 0,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('is a no-op for a guild with no recorded state', () => {
    expect(() => forgetGuildRefreshState('never-seen')).not.toThrow();
  });
});
