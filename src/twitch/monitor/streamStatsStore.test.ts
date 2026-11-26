import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordStreamStatsPoll, getStreamStats, dropUnmonitoredStreamStats, onStreamStatsUpdated, resetStreamStatsForTests,
} from './streamStatsStore';
import type { TwitchStream } from '../twitchApi';

const NOW = new Date('2026-11-26T10:00:00.000Z');

/** A live Helix stream for `streamer_one` with every field the store keeps. */
function stream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return {
    user_id: 'u1', user_login: 'streamer_one', game_name: 'Just Chatting', title: 'A title',
    thumbnail_url: '', type: 'live', started_at: '2026-11-26T09:00:00Z', viewer_count: 42, ...overrides,
  };
}

beforeEach(() => resetStreamStatsForTests());

describe('recordStreamStatsPoll', () => {
  it('stores a live login with title, category, viewers and start time, stamped with the check time', () => {
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', stream()]]), NOW);
    expect(getStreamStats('streamer_one')).toEqual({
      live: true, title: 'A title', category: 'Just Chatting', viewerCount: 42,
      startedAt: '2026-11-26T09:00:00Z', checkedAt: NOW.toISOString(),
    });
  });

  it('stores a login Helix did not list as offline, with nothing but the check time', () => {
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map(), NOW);
    expect(getStreamStats('streamer_one')).toEqual({ live: false, checkedAt: NOW.toISOString() });
  });

  it('leaves out fields Helix gave nothing usable for, rather than inventing them', () => {
    const bad = stream({ title: '', game_name: '', viewer_count: -3, started_at: 'not a date' });
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', bad]]), NOW);
    expect(getStreamStats('streamer_one')).toEqual({ live: true, checkedAt: NOW.toISOString() });
    const fractional = stream({ viewer_count: 1.5 });
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', fractional]]), NOW);
    expect(getStreamStats('streamer_one')).not.toHaveProperty('viewerCount');
    const missing = stream({ viewer_count: undefined, started_at: undefined });
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', missing]]), NOW);
    expect(getStreamStats('streamer_one')).not.toHaveProperty('viewerCount');
    expect(getStreamStats('streamer_one')).not.toHaveProperty('startedAt');
  });

  it('keeps a zero viewer count (a live stream nobody is watching yet)', () => {
    recordStreamStatsPoll(new Map([['streamer_one', 'u1']]), new Map([['u1', stream({ viewer_count: 0 })]]), NOW);
    expect(getStreamStats('streamer_one')?.viewerCount).toBe(0);
  });

  it('tells every listener once, with the logins written, and none when nothing was checked', () => {
    const listener = vi.fn();
    onStreamStatsUpdated(listener);
    recordStreamStatsPoll(new Map([['streamer_one', 'u1'], ['streamer_two', 'u2']]), new Map(), NOW);
    expect(listener).toHaveBeenCalledExactlyOnceWith(['streamer_one', 'streamer_two']);
    listener.mockClear();
    recordStreamStatsPoll(new Map(), new Map(), NOW);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps stats per login, so one channel never reads another\'s', () => {
    recordStreamStatsPoll(
      new Map([['streamer_one', 'u1'], ['streamer_two', 'u2']]),
      new Map([['u1', stream()], ['u2', stream({ user_id: 'u2', title: 'Other', viewer_count: 7 })]]), NOW,
    );
    expect(getStreamStats('streamer_one')?.viewerCount).toBe(42);
    expect(getStreamStats('streamer_two')?.viewerCount).toBe(7);
    expect(getStreamStats('streamer_three')).toBeUndefined();
  });
});

describe('dropUnmonitoredStreamStats', () => {
  it('forgets the logins no longer monitored and keeps the rest', () => {
    recordStreamStatsPoll(new Map([['streamer_one', 'u1'], ['streamer_two', 'u2']]), new Map(), NOW);
    dropUnmonitoredStreamStats(['streamer_one'].values());
    expect(getStreamStats('streamer_one')).toBeDefined();
    expect(getStreamStats('streamer_two')).toBeUndefined();
  });
});
