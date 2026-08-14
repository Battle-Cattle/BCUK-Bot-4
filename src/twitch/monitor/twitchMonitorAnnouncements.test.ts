import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { deferred } from '../../test-utils/deferredPromise';
import { flushMicrotasks } from '../../test-utils/flushMicrotasks';

// Shared with the discordUtils mock factory below so tests can still drive
// isDiscordNotFoundError's return value directly, even though production code
// now only calls it indirectly (from inside the mocked tryEditDiscordMessage).
const { isDiscordNotFoundErrorMock } = vi.hoisted(() => ({
  isDiscordNotFoundErrorMock: vi.fn().mockReturnValue(false),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../discord/discordBot', () => ({ getDiscordClient: vi.fn() }));
vi.mock('../../discord/discordUtils', () => ({
  isDiscordNotFoundError: isDiscordNotFoundErrorMock,
  tryDeleteDiscordMessage: vi.fn().mockResolvedValue(undefined),
  // Minimal re-implementations driven by the same mock Discord client/channel
  // objects the tests already construct, so call-chain assertions (channel.send,
  // channel._message.edit, etc.) keep working unchanged.
  getTextChannel: vi.fn(async (client: any, channelId: string) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    return channel;
  }),
  tryEditDiscordMessage: vi.fn(async (client: any, channelId: string, messageId: string, payload: any) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return false;
    try {
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
      return true;
    } catch (err) {
      if (isDiscordNotFoundErrorMock(err)) return false;
      throw err;
    }
  }),
}));
vi.mock('../../db', () => ({
  setStreamerLive: vi.fn().mockResolvedValue(undefined),
  clearStreamerLive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitchMonitorEmbed', () => ({
  buildEmbed: vi.fn().mockReturnValue({ title: 'embed' }),
  templateVars: vi.fn().mockReturnValue({}),
}));
vi.mock('../../shared/textTemplate', () => ({
  fillTemplate: vi.fn().mockReturnValue('Live message'),
}));
vi.mock('./twitchMonitorMultitwitch', () => ({
  updateMultitwitch: vi.fn().mockResolvedValue(undefined),
}));

import { postAnnouncement, editAnnouncement, deleteAnnouncement } from './twitchMonitorAnnouncements';
import { getDiscordClient } from '../../discord/discordBot';
import { isDiscordNotFoundError, tryDeleteDiscordMessage } from '../../discord/discordUtils';
import { setStreamerLive, clearStreamerLive } from '../../db';
import { updateMultitwitch } from './twitchMonitorMultitwitch';
import type { DbStreamGroup, DbStreamerFull } from '../../db';
import type { TwitchStream } from '../twitchApi';
import type { LiveState } from './twitchMonitorTypes';

function makeGroup(overrides: Partial<DbStreamGroup> = {}): DbStreamGroup {
  return { id: 1, guild_id: 'guild-1', name: 'G1', discord_channel: 'ch1', live_message: 'Live!', new_game_message: 'New game!', multi_twitch: false, delete_old_posts: false, ...overrides };
}

function makeStreamer(overrides: Partial<DbStreamerFull> = {}): DbStreamerFull {
  return { id: 10, discord_id: 'discord1', twitch_name: 'alice', group: makeGroup(), discord_message_id: null, discord_channel_id: null, live_game: null, ...overrides };
}

function makeStream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return { user_id: 'u1', user_login: 'alice', game_name: 'Chess', type: 'live', title: 'Playing', thumbnail_url: '', ...overrides };
}

function makeTextChannel(msgOverrides: Record<string, unknown> = {}) {
  const message = { id: 'msg1', channelId: 'ch1', delete: vi.fn().mockResolvedValue(undefined), edit: vi.fn().mockResolvedValue(undefined), ...msgOverrides };
  return {
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: 'msg1', channelId: 'ch1' }),
    messages: { fetch: vi.fn().mockResolvedValue(message) },
    _message: message,
  };
}

function makeDiscordClient(channel: ReturnType<typeof makeTextChannel> | null = null) {
  return {
    channels: { fetch: vi.fn().mockResolvedValue(channel ?? makeTextChannel()) },
  };
}

function makeLiveState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    streamerId: 10, groupId: 1, group: makeGroup(), login: 'alice',
    messageId: 'msg1', channelId: 'ch1', currentGame: 'Chess', title: 'Playing',
    currentStream: makeStream(), offlineTimer: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── postAnnouncement ─────────────────────────────────────────────────────────

describe('postAnnouncement', () => {
  it('sets state with null message fields when no discord client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    const liveStates = new Map<string, LiveState>();
    await postAnnouncement(liveStates, makeStreamer(), makeStream());
    expect(liveStates.get('10')?.messageId).toBeNull();
    expect(liveStates.get('10')?.channelId).toBeNull();
  });

  it('does not call setStreamerLive when no discord client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    await postAnnouncement(new Map(), makeStreamer(), makeStream());
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  it('sends message and sets live state when client and channel are available', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const liveStates = new Map<string, LiveState>();
    await postAnnouncement(liveStates, makeStreamer(), makeStream());
    expect(channel.send).toHaveBeenCalled();
    expect(liveStates.get('10')?.messageId).toBe('msg1');
    expect(setStreamerLive).toHaveBeenCalledWith(10, 'msg1', 'ch1', 'Chess');
  });

  it('calls updateMultitwitch after posting', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    await postAnnouncement(new Map(), makeStreamer(), makeStream());
    expect(updateMultitwitch).toHaveBeenCalledWith(1, expect.any(Map));
  });

  it('logs error and does not set state when channel is not text-based', async () => {
    const nonText = { isTextBased: () => false };
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockResolvedValue(nonText) } } as any);
    const liveStates = new Map<string, LiveState>();
    await postAnnouncement(liveStates, makeStreamer(), makeStream());
    expect(liveStates.size).toBe(0);
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  it('logs error and does not throw when channel fetch fails', async () => {
    vi.mocked(getDiscordClient).mockReturnValue({ channels: { fetch: vi.fn().mockRejectedValue(new Error('network')) } } as any);
    await expect(postAnnouncement(new Map(), makeStreamer(), makeStream())).resolves.not.toThrow();
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  // A withLoginLock timeout doesn't cancel postAnnouncement — it may still be running (and could
  // still send/mutate) after a newer same-login operation has taken over. isCurrent must be
  // re-checked after each await so a superseded call stops instead of racing the newer one
  // (CodeRabbit review finding on PR #533).
  it('sends the message but skips liveStates/DB updates once superseded partway through', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    let current = true;
    // Simulate a newer operation taking over while this send is in flight.
    channel.send.mockImplementation(async () => { current = false; return { id: 'msg1', channelId: 'ch1' }; });
    const liveStates = new Map<string, LiveState>();

    await postAnnouncement(liveStates, makeStreamer(), makeStream(), () => current);

    expect(channel.send).toHaveBeenCalled(); // already in flight before staleness could be observed
    expect(liveStates.size).toBe(0);
    expect(setStreamerLive).not.toHaveBeenCalled();
    expect(updateMultitwitch).not.toHaveBeenCalled();
  });

  // CodeRabbit review finding on PR #533: setStreamerLive's own DB write has no ordering
  // guarantee against another in-flight write for the same streamer, so a slow, stale write could
  // otherwise complete *after* a faster, newer write and silently overwrite it. Writes are now
  // serialized per streamer ID, so the older call's write is guaranteed to fully complete (for
  // better or worse) before the newer call's write can even start — the newer write always lands
  // last, regardless of how long the older one takes to settle.
  it('does not let a slow write for one call clobber a faster write from a later call for the same streamer', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const streamer = makeStreamer(); // same streamer (id: 10) for both calls
    const liveStates = new Map<string, LiveState>();

    const staleWrite = deferred<void>();
    vi.mocked(setStreamerLive).mockReturnValueOnce(staleWrite.promise);

    const stalePromise = postAnnouncement(liveStates, streamer, makeStream({ game_name: 'Stale Game' }));
    await flushMicrotasks(); // let the first call reach and start its (deferred) DB write

    const freshPromise = postAnnouncement(liveStates, streamer, makeStream({ game_name: 'Fresh Game' }));
    await flushMicrotasks(); // the second call's write must be queued behind the first, not racing it
    expect(setStreamerLive).toHaveBeenCalledTimes(1); // only the stale write has been issued so far

    staleWrite.resolve();
    await Promise.all([stalePromise, freshPromise]);

    expect(setStreamerLive).toHaveBeenCalledTimes(2);
    expect(setStreamerLive).toHaveBeenNthCalledWith(1, 10, 'msg1', 'ch1', 'Stale Game');
    expect(setStreamerLive).toHaveBeenNthCalledWith(2, 10, 'msg1', 'ch1', 'Fresh Game'); // the newer write lands last
  });

  // CodeRabbit review finding on PR #533: setStreamerLive ran inside the per-streamer persist
  // queue with no timeout, so a stalled DB call could wedge that streamer's queue forever —
  // exactly the class of bug this PR otherwise guards against for Twitch/Discord calls.
  it('times out a hung setStreamerLive write and still releases the queue for a later write to the same streamer', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const streamer = makeStreamer(); // same streamer (id: 10) for both calls
    vi.mocked(setStreamerLive).mockImplementationOnce(() => new Promise(() => {})); // hangs

    const hungPromise = postAnnouncement(new Map(), streamer, makeStream());
    await vi.advanceTimersByTimeAsync(10_000); // PERSIST_TIMEOUT_MS
    // postAnnouncement's own try/catch swallows and logs the timeout — it must still resolve
    // rather than hang forever waiting on the DB write.
    await expect(hungPromise).resolves.toBeUndefined();

    vi.mocked(setStreamerLive).mockResolvedValue(undefined);
    await expect(postAnnouncement(new Map(), streamer, makeStream())).resolves.toBeUndefined();
    expect(setStreamerLive).toHaveBeenCalledTimes(2); // the later write wasn't queued behind the hung one forever
  });
});

// ─── editAnnouncement ─────────────────────────────────────────────────────────

describe('editAnnouncement', () => {
  it('returns early when no discord client', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);
    const state = makeLiveState();
    await editAnnouncement(new Map(), state, makeStream(), 'live_message');
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  it('returns early when state has no messageId', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient() as any);
    const state = makeLiveState({ messageId: null });
    await editAnnouncement(new Map(), state, makeStream(), 'live_message');
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  it('edits the existing message when delete_old_posts is false', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: false }) });
    await editAnnouncement(new Map(), state, makeStream(), 'live_message');
    expect(channel._message.edit).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(setStreamerLive).toHaveBeenCalled();
  });

  it('deletes old message via tryDeleteDiscordMessage and sends new one when delete_old_posts is true and game changed', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: true }) });
    await editAnnouncement(new Map(), state, makeStream(), 'new_game_message');
    expect(tryDeleteDiscordMessage).toHaveBeenCalledWith('ch1', 'msg1');
    expect(channel.send).toHaveBeenCalled();
    expect(setStreamerLive).toHaveBeenCalled();
  });

  it('treats old-message delete failure as best-effort and still commits the new message on a game change', async () => {
    vi.mocked(tryDeleteDiscordMessage).mockRejectedValueOnce(new Error('network'));
    const channel = makeTextChannel();
    channel.send.mockResolvedValue({ id: 'msg2', channelId: 'ch1' });
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: true }) });
    await expect(editAnnouncement(new Map(), state, makeStream(), 'new_game_message')).resolves.not.toThrow();
    expect(state.messageId).toBe('msg2');
    expect(setStreamerLive).toHaveBeenCalled();
  });

  it('edits the existing message in place for a title-only change even when delete_old_posts is true', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: true }) });
    await editAnnouncement(new Map(), state, makeStream(), 'live_message');
    expect(channel._message.edit).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(tryDeleteDiscordMessage).not.toHaveBeenCalled();
    expect(setStreamerLive).toHaveBeenCalled();
  });

  it('updates state currentGame and title from stream', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    const state = makeLiveState();
    const newStream = makeStream({ game_name: 'Minecraft', title: 'New Title' });
    await editAnnouncement(new Map(), state, newStream, 'new_game_message');
    expect(state.currentGame).toBe('Minecraft');
    expect(state.title).toBe('New Title');
  });

  it('posts a fresh message when the existing message is gone and delete_old_posts is false', async () => {
    const notFoundErr = new Error('Unknown Message');
    const channel = makeTextChannel();
    channel.send.mockResolvedValue({ id: 'msg2', channelId: 'ch1' });
    channel.messages.fetch.mockRejectedValue(notFoundErr);
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(true);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: false }) });
    await editAnnouncement(new Map(), state, makeStream(), 'live_message');
    expect(channel.send).toHaveBeenCalled();
    expect(state.messageId).toBe('msg2');
    expect(setStreamerLive).toHaveBeenCalled();
  });

  it('rethrows non-NotFound fetch errors when delete_old_posts is false', async () => {
    const channel = makeTextChannel();
    channel.messages.fetch.mockRejectedValue(new Error('network'));
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: false }) });
    await expect(editAnnouncement(new Map(), state, makeStream(), 'live_message')).resolves.not.toThrow();
    // Error is caught by outer try/catch and logged; state is not updated.
    expect(setStreamerLive).not.toHaveBeenCalled();
  });

  // Mirrors the postAnnouncement isCurrent fencing tests above (CodeRabbit review finding on PR
  // #533) — a withLoginLock timeout doesn't cancel editAnnouncement, so isCurrent must be
  // re-checked after each await so a superseded call stops instead of racing a newer operation.
  it('edits the message but skips DB/multitwitch updates once superseded partway through', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    let current = true;
    channel._message.edit.mockImplementation(async () => { current = false; });
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: false }) });

    await editAnnouncement(new Map(), state, makeStream(), 'live_message', () => current);

    expect(channel._message.edit).toHaveBeenCalled();
    expect(setStreamerLive).not.toHaveBeenCalled();
    expect(updateMultitwitch).not.toHaveBeenCalled();
  });

  it('reposts the message but skips recording its id on state, and skips deleting the old one, once superseded partway through', async () => {
    const channel = makeTextChannel();
    vi.mocked(getDiscordClient).mockReturnValue(makeDiscordClient(channel) as any);
    let current = true;
    channel.send.mockImplementation(async () => { current = false; return { id: 'msg2', channelId: 'ch1' }; });
    const state = makeLiveState({ group: makeGroup({ delete_old_posts: true }) });
    const originalMessageId = state.messageId;

    await editAnnouncement(new Map(), state, makeStream(), 'new_game_message', () => current);

    expect(channel.send).toHaveBeenCalled();
    expect(state.messageId).toBe(originalMessageId); // repost()'s own state mutation was skipped
    expect(tryDeleteDiscordMessage).not.toHaveBeenCalled();
    expect(setStreamerLive).not.toHaveBeenCalled();
  });
});

// ─── deleteAnnouncement ───────────────────────────────────────────────────────

describe('deleteAnnouncement', () => {
  it('deletes key from map and returns early when no state', async () => {
    const liveStates = new Map<string, LiveState>();
    await deleteAnnouncement(liveStates, 'missing_key');
    expect(tryDeleteDiscordMessage).not.toHaveBeenCalled();
  });

  it('deletes key from map and returns early when state has no messageId', async () => {
    const liveStates = new Map([['k', makeLiveState({ messageId: null })]]);
    await deleteAnnouncement(liveStates, 'k');
    expect(tryDeleteDiscordMessage).not.toHaveBeenCalled();
    expect(liveStates.has('k')).toBe(false);
  });

  it('calls tryDeleteDiscordMessage, clearStreamerLive, and updateMultitwitch', async () => {
    const liveStates = new Map([['k', makeLiveState({ messageId: 'msg1', channelId: 'ch1', streamerId: 10, groupId: 1 })]]);
    await deleteAnnouncement(liveStates, 'k');
    expect(tryDeleteDiscordMessage).toHaveBeenCalledWith('ch1', 'msg1');
    expect(clearStreamerLive).toHaveBeenCalledWith(10);
    expect(updateMultitwitch).toHaveBeenCalledWith(1, liveStates);
    expect(liveStates.has('k')).toBe(false);
  });

  it('still clears DB and map state when tryDeleteDiscordMessage rejects', async () => {
    vi.mocked(tryDeleteDiscordMessage).mockRejectedValueOnce(new Error('network'));
    const liveStates = new Map([['k', makeLiveState({ messageId: 'msg1', channelId: 'ch1', streamerId: 10, groupId: 1 })]]);
    await expect(deleteAnnouncement(liveStates, 'k')).resolves.not.toThrow();
    expect(clearStreamerLive).toHaveBeenCalledWith(10);
    expect(updateMultitwitch).toHaveBeenCalledWith(1, liveStates);
    expect(liveStates.has('k')).toBe(false);
  });
});
