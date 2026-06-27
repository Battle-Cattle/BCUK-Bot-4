import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
vi.mock('../../discord/discordBot', () => ({ getDiscordClient: vi.fn() }));
vi.mock('../../discord/discordUtils', () => ({
  isDiscordNotFoundError: vi.fn().mockReturnValue(false),
  tryDeleteDiscordMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db', () => ({
  setStreamerLive: vi.fn().mockResolvedValue(undefined),
  clearStreamerLive: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitchMonitorEmbed', () => ({
  buildEmbed: vi.fn().mockReturnValue({ title: 'embed' }),
  fillTemplate: vi.fn().mockReturnValue('Live message'),
  templateVars: vi.fn().mockReturnValue({}),
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
  return { id: 1, name: 'G1', discord_channel: 'ch1', live_message: 'Live!', new_game_message: 'New game!', multi_twitch: false, delete_old_posts: false, ...overrides };
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
  vi.mocked(isDiscordNotFoundError).mockReturnValue(false);
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
