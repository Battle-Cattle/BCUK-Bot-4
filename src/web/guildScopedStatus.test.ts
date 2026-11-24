import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/statusStore', () => ({
  getStatus: vi.fn(),
}));

// The real registry, so a test can fire a change as the `src/db` wrappers do.
vi.mock('../db', async () => {
  const events = await vi.importActual<typeof import('../db/guildInfoEvents')>('../db/guildInfoEvents');
  return { getGuildById: vi.fn(), getGuildMemberUsers: vi.fn(), onGuildInfoChanged: events.onGuildInfoChanged };
});

vi.mock('../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((s: string) => (s ? s.toLowerCase() : null)),
}));

import { getGuildScopedStatus, clearGuildScopedStatusCache, onGuildStatusInvalidated } from './guildScopedStatus';
import { getStatus } from '../shared/statusStore';
import { getGuildById, getGuildMemberUsers } from '../db';
import { notifyGuildInfoChanged } from '../db/guildInfoEvents';

const BASE_STATUS = {
  discord: { ready: true, tag: 'Bot#1234' },
  voice: { connected: false, channelName: null, playing: false, currentFile: null, lastCommand: null, lastSource: null, lastPlayedAt: null, lastFile: null, lastUser: null, lastChannel: null },
  twitch: {
    ourstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false },
    otherguildstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // The guild-info cache is a module-level singleton (short TTL in production) — reset it
  // so each test's DB mocks aren't shadowed by a previous test's cached result.
  clearGuildScopedStatusCache();
  vi.mocked(getStatus).mockReturnValue(BASE_STATUS as any);
  vi.mocked(getGuildById).mockResolvedValue({ guild_id: 'guild-A', name: 'Our Guild', voice_channel_id: null });
  vi.mocked(getGuildMemberUsers).mockResolvedValue([
    { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: true, twitch_name: 'ourstreamer', access_level: 2, is_owner: false, session_generation: 0 },
  ]);
});

describe('getGuildScopedStatus — null guildId', () => {
  it('returns an empty-scoped snapshot without any DB lookup', async () => {
    const result = await getGuildScopedStatus(null);
    expect(result.discord.guildName).toBeNull();
    expect(result.twitch).toEqual({});
    expect(getGuildById).not.toHaveBeenCalled();
    expect(getGuildMemberUsers).not.toHaveBeenCalled();
  });

  it('still passes null through to the underlying statusStore lookup', async () => {
    await getGuildScopedStatus(null);
    expect(getStatus).toHaveBeenCalledWith(null);
  });
});

describe('getGuildScopedStatus — discord.guildName', () => {
  it('resolves to the requested guild\'s own name, not a joined list of every guild', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(result.discord.guildName).toBe('Our Guild');
    expect(getGuildById).toHaveBeenCalledWith('guild-A');
  });

  it('is null when the guild is not found in the DB, without throwing', async () => {
    vi.mocked(getGuildById).mockResolvedValue(null);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.discord.guildName).toBeNull();
  });
});

describe('getGuildScopedStatus — twitch scoping', () => {
  it('includes only channels owned by this guild\'s twitch-bot-enabled members', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(Object.keys(result.twitch)).toEqual(['ourstreamer']);
    expect(result.twitch.otherguildstreamer).toBeUndefined();
  });

  it('excludes a member\'s twitch channel when is_twitch_bot_enabled is false', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: false, twitch_name: 'ourstreamer', access_level: 2, is_owner: false, session_generation: 0 },
    ]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });

  it('excludes a member with no twitch_name set', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([
      { discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: true, twitch_name: null, access_level: 2, is_owner: false, session_generation: 0 },
    ]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });

  it('returns no twitch channels when the guild has no members', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
    const result = await getGuildScopedStatus('guild-A');
    expect(result.twitch).toEqual({});
  });
});

describe('getGuildScopedStatus — voice', () => {
  it('passes through the already guild-scoped voice status unchanged', async () => {
    const result = await getGuildScopedStatus('guild-A');
    expect(result.voice).toEqual(BASE_STATUS.voice);
  });

  it('carries the last-played fields in both the guild and the no-guild snapshot, and nothing else is added', async () => {
    const expected = Object.keys(BASE_STATUS.voice).sort();
    expect(expected).toEqual(expect.arrayContaining(['lastFile', 'lastUser', 'lastChannel']));
    expect(Object.keys((await getGuildScopedStatus('guild-A')).voice).sort()).toEqual(expected);
    expect(Object.keys((await getGuildScopedStatus(null)).voice).sort()).toEqual(expected);
  });
});

describe('getGuildScopedStatus — guild-info caching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the cached guild/member lookup for a second call within the TTL', async () => {
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-A');
    expect(getGuildById).toHaveBeenCalledTimes(1);
    expect(getGuildMemberUsers).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    await getGuildScopedStatus('guild-A');
    vi.advanceTimersByTime(20_001);
    await getGuildScopedStatus('guild-A');
    expect(getGuildById).toHaveBeenCalledTimes(2);
    expect(getGuildMemberUsers).toHaveBeenCalledTimes(2);
  });

  it('caches independently per guild', async () => {
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-B');
    expect(getGuildById).toHaveBeenCalledTimes(2);
    expect(getGuildById).toHaveBeenNthCalledWith(1, 'guild-A');
    expect(getGuildById).toHaveBeenNthCalledWith(2, 'guild-B');
  });

  it('coalesces concurrent cache misses for the same guild onto a single DB fetch', async () => {
    let resolveGuild!: (value: { guild_id: string; name: string; voice_channel_id: string | null }) => void;
    vi.mocked(getGuildById).mockReturnValue(new Promise((resolve) => { resolveGuild = resolve; }));

    // Two callers race in before the first fetch resolves — e.g. a status poll and a
    // pushStatusUpdate broadcast landing for the same guild at the same time.
    const first = getGuildScopedStatus('guild-A');
    const second = getGuildScopedStatus('guild-A');

    resolveGuild({ guild_id: 'guild-A', name: 'Our Guild', voice_channel_id: null });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(getGuildById).toHaveBeenCalledTimes(1);
    expect(getGuildMemberUsers).toHaveBeenCalledTimes(1);
    expect(firstResult.discord.guildName).toBe('Our Guild');
    expect(secondResult.discord.guildName).toBe('Our Guild');
  });
});

// ─── invalidation (#1113) ───────────────────────────────────────────────────────

/** A promise whose resolution a test controls, to hold a DB lookup in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const MEMBER = (twitchName: string) => ({
  discord_id: '1', discord_name: 'Streamer', is_twitch_bot_enabled: true, twitch_name: twitchName, access_level: 2, is_owner: false, session_generation: 0,
});

describe('getGuildScopedStatus — invalidation', () => {
  it('refetches after the guild is reported changed, instead of waiting out the TTL', async () => {
    await getGuildScopedStatus('guild-A');
    expect(getGuildById).toHaveBeenCalledTimes(1);

    notifyGuildInfoChanged('guild-A');
    vi.mocked(getGuildById).mockResolvedValue({ guild_id: 'guild-A', name: 'Renamed', voice_channel_id: null });
    const result = await getGuildScopedStatus('guild-A');

    expect(getGuildById).toHaveBeenCalledTimes(2);
    expect(result.discord.guildName).toBe('Renamed');
  });

  it('keeps serving the cache when nothing changed', async () => {
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-A');
    expect(getGuildById).toHaveBeenCalledTimes(1);
  });

  it('leaves other guilds\' cached entries alone', async () => {
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-B');
    expect(getGuildById).toHaveBeenCalledTimes(2);

    notifyGuildInfoChanged('guild-A');
    await getGuildScopedStatus('guild-B');
    expect(getGuildById).toHaveBeenCalledTimes(2);
    await getGuildScopedStatus('guild-A');
    expect(getGuildById).toHaveBeenCalledTimes(3);
  });

  it('drops every guild\'s entry for a change that can touch any guild (null)', async () => {
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-B');

    notifyGuildInfoChanged(null);
    await getGuildScopedStatus('guild-A');
    await getGuildScopedStatus('guild-B');

    expect(getGuildById).toHaveBeenCalledTimes(4);
  });

  it('shows a newly enabled channel straight after the write (the join/part push that follows must see fresh members)', async () => {
    vi.mocked(getGuildMemberUsers).mockResolvedValue([MEMBER('ourstreamer')] as any);
    expect(Object.keys((await getGuildScopedStatus('guild-A')).twitch)).toEqual(['ourstreamer']);

    vi.mocked(getGuildMemberUsers).mockResolvedValue([MEMBER('ourstreamer'), MEMBER('otherguildstreamer')] as any);
    notifyGuildInfoChanged(null);
    expect(Object.keys((await getGuildScopedStatus('guild-A')).twitch).sort()).toEqual(['otherguildstreamer', 'ourstreamer']);
  });

  it('does not re-cache a load that was still in flight when the guild changed, and a call made after the change runs a fresh load', async () => {
    const stale = deferred<any[]>();
    vi.mocked(getGuildMemberUsers).mockReturnValueOnce(stale.promise as any);
    const first = getGuildScopedStatus('guild-A');
    await Promise.resolve();

    notifyGuildInfoChanged('guild-A');
    vi.mocked(getGuildMemberUsers).mockResolvedValue([MEMBER('otherguildstreamer')] as any);
    const second = await getGuildScopedStatus('guild-A');
    expect(Object.keys(second.twitch)).toEqual(['otherguildstreamer']);

    stale.resolve([MEMBER('ourstreamer')]);
    const firstResult = await first;
    // The stale load still answers the callers that were waiting on it ...
    expect(Object.keys(firstResult.twitch)).toEqual(['ourstreamer']);
    // ... but must not overwrite the fresh rows in the cache.
    const third = await getGuildScopedStatus('guild-A');
    expect(Object.keys(third.twitch)).toEqual(['otherguildstreamer']);
  });

  it('rejects with the lookup\'s own error, and leaves nothing stuck in flight, when a lookup throws before returning a promise', async () => {
    vi.mocked(getGuildById).mockImplementationOnce(() => { throw new Error('sync failure'); });
    await expect(getGuildScopedStatus('guild-A')).rejects.toThrow('sync failure');

    // The next call isn't joined to the failed load: it fetches afresh.
    const result = await getGuildScopedStatus('guild-A');
    expect(result.discord.guildName).toBe('Our Guild');
  });

  it('keeps coalescing concurrent loads after an invalidation: a stale load finishing does not drop the fresh load\'s in-flight entry', async () => {
    const stale = deferred<any[]>();
    const fresh = deferred<any[]>();
    vi.mocked(getGuildMemberUsers).mockReturnValueOnce(stale.promise as any).mockReturnValueOnce(fresh.promise as any);
    const first = getGuildScopedStatus('guild-A');
    await Promise.resolve();
    notifyGuildInfoChanged('guild-A');
    const second = getGuildScopedStatus('guild-A');
    await Promise.resolve();

    stale.resolve([MEMBER('ourstreamer')]);
    await first;
    const third = getGuildScopedStatus('guild-A');
    fresh.resolve([MEMBER('otherguildstreamer')]);
    await Promise.all([second, third]);

    expect(getGuildMemberUsers).toHaveBeenCalledTimes(2);
  });
});

// ─── invalidation listeners (#1117) ──────────────────────────────────────────────

describe('onGuildStatusInvalidated', () => {
  it('calls the listener with the changed guild, and with null for a change that can touch any guild', () => {
    const listener = vi.fn();
    const off = onGuildStatusInvalidated(listener);
    notifyGuildInfoChanged('guild-A');
    notifyGuildInfoChanged(null);
    expect(listener.mock.calls).toEqual([['guild-A'], [null]]);
    off();
  });

  it('runs after the cache was dropped, so a snapshot built inside it reads the new rows', async () => {
    await getGuildScopedStatus('guild-A');
    vi.mocked(getGuildMemberUsers).mockResolvedValue([MEMBER('otherguildstreamer')] as any);
    let seen: string[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    const off = onGuildStatusInvalidated((guildId) => {
      pending = getGuildScopedStatus(guildId).then((status) => { seen = Object.keys(status.twitch); });
    });

    notifyGuildInfoChanged('guild-A');
    await pending;

    expect(seen).toEqual(['otherguildstreamer']);
    off();
  });

  it('stops calling a listener once it is removed', () => {
    const listener = vi.fn();
    const off = onGuildStatusInvalidated(listener);
    off();
    notifyGuildInfoChanged('guild-A');
    expect(listener).not.toHaveBeenCalled();
  });

  it('logs a listener that throws and still calls the rest, without failing the write that triggered it', () => {
    const after = vi.fn();
    const offBad = onGuildStatusInvalidated(() => { throw new Error('listener broke'); });
    const offAfter = onGuildStatusInvalidated(after);

    expect(() => notifyGuildInfoChanged('guild-A')).not.toThrow();

    expect(after).toHaveBeenCalledExactlyOnceWith('guild-A');
    offBad();
    offAfter();
  });
});

// ─── live-check time in the snapshot (#1083) ─────────────────────────────────────

describe('getGuildScopedStatus — liveCheckedAt', () => {
  it('carries each channel\'s liveCheckedAt through, as a time that serialises to ISO and as null before the first check', async () => {
    const checked = new Date('2026-11-23T10:00:00Z');
    vi.mocked(getGuildMemberUsers).mockResolvedValue([MEMBER('ourstreamer'), MEMBER('otherguildstreamer')] as any);
    vi.mocked(getStatus).mockReturnValue({
      ...BASE_STATUS,
      twitch: {
        ourstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: true, liveCheckedAt: checked },
        otherguildstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false, liveCheckedAt: null },
      },
    } as any);

    const result = await getGuildScopedStatus('guild-A');

    expect(result.twitch['ourstreamer']!.liveCheckedAt).toBe(checked);
    expect(JSON.parse(JSON.stringify(result)).twitch.ourstreamer.liveCheckedAt).toBe('2026-11-23T10:00:00.000Z');
    expect(result.twitch['otherguildstreamer']!.liveCheckedAt).toBeNull();
  });

  it('still scopes by guild: another guild\'s channel and its time are not included', async () => {
    vi.mocked(getStatus).mockReturnValue({
      ...BASE_STATUS,
      twitch: {
        ourstreamer: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false, liveCheckedAt: new Date() },
        stranger: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false, liveCheckedAt: new Date() },
      },
    } as any);

    const result = await getGuildScopedStatus('guild-A');

    expect(Object.keys(result.twitch)).toEqual(['ourstreamer']);
  });
});
