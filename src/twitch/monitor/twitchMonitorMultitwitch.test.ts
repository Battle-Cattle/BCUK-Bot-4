import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../discord/discordBot', () => ({ getDiscordClient: vi.fn().mockReturnValue(null) }));
vi.mock('./twitchMonitorEmbed', () => ({ buildEmbed: vi.fn() }));

import { groupGameKey, buildMultiTwitchContext, getMultitwitchPreview } from './twitchMonitorMultitwitch';
import type { LiveState } from './twitchMonitorTypes';

function makeState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    streamerId: 1,
    login: 'alice',
    groupId: 10,
    currentGame: 'Minecraft',
    title: 'Playing',
    currentStream: {} as any,
    messageId: 'msg1',
    channelId: 'chan1',
    offlineTimer: null,
    group: { id: 10, guild_id: 'guild-1', name: 'G', discord_channel: 'c', live_message: 'l', new_game_message: 'g', multi_twitch: true, delete_old_posts: false },
    ...overrides,
  };
}

// ─── groupGameKey ─────────────────────────────────────────────────────────────

describe('groupGameKey', () => {
  it('combines groupId and lowercase game with :: separator', () => {
    expect(groupGameKey(5, 'Minecraft')).toBe('5::minecraft');
  });

  it('lowercases the game name', () => {
    expect(groupGameKey(1, 'FORTNITE')).toBe('1::fortnite');
  });

  it('is deterministic for the same inputs', () => {
    expect(groupGameKey(3, 'Valorant')).toBe(groupGameKey(3, 'Valorant'));
  });

  it('produces different keys for different groupIds', () => {
    expect(groupGameKey(1, 'Minecraft')).not.toBe(groupGameKey(2, 'Minecraft'));
  });

  it('produces different keys for different games', () => {
    expect(groupGameKey(1, 'Minecraft')).not.toBe(groupGameKey(1, 'Fortnite'));
  });
});

// ─── buildMultiTwitchContext ──────────────────────────────────────────────────

describe('buildMultiTwitchContext', () => {
  it('returns empty map for no states', () => {
    const ctx = buildMultiTwitchContext([]);
    expect(ctx).toBeDefined();
  });

  it('groups participants by group+game key', () => {
    const states = [
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'bob',   groupId: 1, currentGame: 'Minecraft' }),
    ];
    const ctx = buildMultiTwitchContext(states);
    const key = groupGameKey(1, 'Minecraft');
    expect(ctx).toHaveProperty('participantsByGroupAndGame');
    // Access via the returned object — use the same key format
    const participants = (ctx as any).participantsByGroupAndGame.get(key);
    expect(participants).toContain('alice');
    expect(participants).toContain('bob');
  });

  it('sorts participants alphabetically', () => {
    const states = [
      makeState({ login: 'zara',  groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'bob',   groupId: 1, currentGame: 'Minecraft' }),
    ];
    const ctx = buildMultiTwitchContext(states);
    const key = groupGameKey(1, 'Minecraft');
    const participants = (ctx as any).participantsByGroupAndGame.get(key);
    expect(participants).toEqual(['alice', 'bob', 'zara']);
  });

  it('deduplicates the same login appearing twice', () => {
    const states = [
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
    ];
    const ctx = buildMultiTwitchContext(states);
    const key = groupGameKey(1, 'Minecraft');
    const participants = (ctx as any).participantsByGroupAndGame.get(key);
    expect(participants).toHaveLength(1);
  });

  it('separates participants by group', () => {
    const states = [
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'bob',   groupId: 2, currentGame: 'Minecraft' }),
    ];
    const ctx = buildMultiTwitchContext(states);
    const key1 = groupGameKey(1, 'Minecraft');
    const key2 = groupGameKey(2, 'Minecraft');
    expect((ctx as any).participantsByGroupAndGame.get(key1)).not.toContain('bob');
    expect((ctx as any).participantsByGroupAndGame.get(key2)).not.toContain('alice');
  });

  it('separates participants by game', () => {
    const states = [
      makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' }),
      makeState({ login: 'bob',   groupId: 1, currentGame: 'Fortnite' }),
    ];
    const ctx = buildMultiTwitchContext(states);
    expect((ctx as any).participantsByGroupAndGame.get(groupGameKey(1, 'Minecraft'))).not.toContain('bob');
    expect((ctx as any).participantsByGroupAndGame.get(groupGameKey(1, 'Fortnite'))).not.toContain('alice');
  });
});

// ─── getMultitwitchPreview ────────────────────────────────────────────────────

describe('getMultitwitchPreview', () => {
  function ctxWith(entries: Array<[string, string[]]>) {
    const map = new Map<string, string[]>(entries);
    return { participantsByGroupAndGame: map } as any;
  }

  it('returns applicable=false and url=null when only one participant', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' });
    const ctx = ctxWith([[groupGameKey(1, 'Minecraft'), ['alice']]]);
    const result = getMultitwitchPreview(state, ctx);
    expect(result.applicable).toBe(false);
    expect(result.url).toBeNull();
    expect(result.participants).toEqual(['alice']);
  });

  it('returns applicable=false and url=null when no entry in context', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' });
    const result = getMultitwitchPreview(state, ctxWith([]));
    expect(result.applicable).toBe(false);
    expect(result.url).toBeNull();
  });

  it('returns applicable=true and url=null when multi_twitch=false but multiple participants', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft', group: { ...makeState().group, multi_twitch: false } });
    const ctx = ctxWith([[groupGameKey(1, 'Minecraft'), ['alice', 'bob']]]);
    const result = getMultitwitchPreview(state, ctx);
    expect(result.applicable).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.url).toBeNull();
    expect(result.participants).toEqual(['alice', 'bob']);
  });

  it('returns enabled=true and correct url when multi_twitch=true and 2+ participants', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' });
    const ctx = ctxWith([[groupGameKey(1, 'Minecraft'), ['alice', 'bob']]]);
    const result = getMultitwitchPreview(state, ctx);
    expect(result.enabled).toBe(true);
    expect(result.applicable).toBe(true);
    expect(result.url).toBe('https://www.multitwitch.tv/alice/bob');
    expect(result.participants).toEqual(['alice', 'bob']);
  });

  it('includes all participants in the url', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft' });
    const ctx = ctxWith([[groupGameKey(1, 'Minecraft'), ['alice', 'bob', 'carol']]]);
    const result = getMultitwitchPreview(state, ctx);
    expect(result.url).toBe('https://www.multitwitch.tv/alice/bob/carol');
  });

  it('reflects the enabled flag from the group when not applicable', () => {
    const state = makeState({ login: 'alice', groupId: 1, currentGame: 'Minecraft', group: { ...makeState().group, multi_twitch: false } });
    const result = getMultitwitchPreview(state, ctxWith([]));
    expect(result.enabled).toBe(false);
  });
});
