import { describe, it, expect } from 'vitest';
import type { DbStreamGroup, DbStreamerFull } from '../../db';
import type { TwitchStream } from '../twitchApi';
import { makeLiveState, LiveStateMap, type LiveState } from './twitchMonitorTypes';

function makeGroup(overrides: Partial<DbStreamGroup> = {}): DbStreamGroup {
  return {
    id: 1,
    guild_id: 'guild-1',
    name: 'TestGroup',
    discord_channel: '111',
    live_message: 'Live: {user}',
    new_game_message: 'New game: {game}',
    multi_twitch: false,
    delete_old_posts: false,
    ...overrides,
  };
}

function makeStreamer(overrides: Partial<DbStreamerFull> = {}): DbStreamerFull {
  return {
    id: 10,
    discord_id: 'discord1',
    twitch_name: 'alice',
    group: makeGroup(),
    discord_message_id: null,
    discord_channel_id: null,
    live_game: null,
    ...overrides,
  };
}

function makeStream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return {
    user_id: 'u1',
    user_login: 'Alice',
    game_name: 'Chess',
    type: 'live',
    title: 'Playing chess',
    thumbnail_url: 'https://example.com/thumb.jpg',
    ...overrides,
  };
}

describe('makeLiveState', () => {
  it('sets streamerId from streamer.id', () => {
    const state = makeLiveState(makeStreamer({ id: 42 }), makeStream(), 'msg1', 'ch1');
    expect(state.streamerId).toBe(42);
  });

  it('sets groupId and group from the streamer', () => {
    const group = makeGroup({ id: 7 });
    const state = makeLiveState(makeStreamer({ group }), makeStream(), null, null);
    expect(state.groupId).toBe(7);
    expect(state.group).toBe(group);
  });

  it('lowercases user_login for the login field', () => {
    const state = makeLiveState(makeStreamer(), makeStream({ user_login: 'ALICE' }), null, null);
    expect(state.login).toBe('alice');
  });

  it('stores messageId and channelId', () => {
    const state = makeLiveState(makeStreamer(), makeStream(), 'msg123', 'ch456');
    expect(state.messageId).toBe('msg123');
    expect(state.channelId).toBe('ch456');
  });

  it('accepts null for messageId and channelId', () => {
    const state = makeLiveState(makeStreamer(), makeStream(), null, null);
    expect(state.messageId).toBeNull();
    expect(state.channelId).toBeNull();
  });

  it('sets currentGame from stream.game_name', () => {
    const state = makeLiveState(makeStreamer(), makeStream({ game_name: 'Chess' }), null, null);
    expect(state.currentGame).toBe('Chess');
  });

  it('sets title from stream.title', () => {
    const state = makeLiveState(makeStreamer(), makeStream({ title: 'My Stream' }), null, null);
    expect(state.title).toBe('My Stream');
  });

  it('sets offlineTimer to null', () => {
    const state = makeLiveState(makeStreamer(), makeStream(), null, null);
    expect(state.offlineTimer).toBeNull();
  });

  it('stores the full stream object as currentStream', () => {
    const stream = makeStream();
    const state = makeLiveState(makeStreamer(), stream, null, null);
    expect(state.currentStream).toBe(stream);
  });
});

// ─── LiveStateMap ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<LiveState> = {}): LiveState {
  return {
    streamerId: 1,
    login: 'alice',
    groupId: 10,
    currentGame: 'Minecraft',
    title: 'Playing',
    currentStream: {} as TwitchStream,
    messageId: 'msg1',
    channelId: 'chan1',
    offlineTimer: null,
    group: makeGroup(),
    ...overrides,
  };
}

describe('LiveStateMap', () => {
  it('getByLogin returns undefined for an unknown login', () => {
    const map = new LiveStateMap();
    expect(map.getByLogin('nobody')).toBeUndefined();
  });

  it('getByLogin resolves a state in O(1) via the login index after set', () => {
    const map = new LiveStateMap();
    const state = makeState({ login: 'alice' });
    map.set('10', state);
    expect(map.getByLogin('alice')).toBe(state);
  });

  it('behaves as a normal Map for get/has/values by key', () => {
    const map = new LiveStateMap();
    const state = makeState({ login: 'alice' });
    map.set('10', state);
    expect(map.get('10')).toBe(state);
    expect(map.has('10')).toBe(true);
    expect(Array.from(map.values())).toEqual([state]);
  });

  it('re-setting the same key with a different login moves the login index', () => {
    const map = new LiveStateMap();
    map.set('10', makeState({ login: 'alice' }));
    const updated = makeState({ login: 'bob' });
    map.set('10', updated);

    expect(map.getByLogin('bob')).toBe(updated);
    expect(map.getByLogin('alice')).toBeUndefined();
  });

  it('delete removes the login index entry', () => {
    const map = new LiveStateMap();
    map.set('10', makeState({ login: 'alice' }));
    map.delete('10');

    expect(map.getByLogin('alice')).toBeUndefined();
    expect(map.has('10')).toBe(false);
  });

  it('set() evicts a stale entry under a different key when the same login moves without delete()', () => {
    // A login moving from key "10" to key "11" (a streamer re-registering under a new DB
    // row id) without an intervening delete("10") must not leave two Map entries for the
    // same login.
    const map = new LiveStateMap();
    const first = makeState({ login: 'alice' });
    const second = makeState({ login: 'alice' });
    map.set('10', first);
    map.set('11', second);

    expect(map.has('10')).toBe(false);
    expect(map.get('11')).toBe(second);
    expect(map.getByLogin('alice')).toBe(second);
    expect(map.size).toBe(1);
  });

  it('delete on a key already evicted by a later set() is a harmless no-op', () => {
    const map = new LiveStateMap();
    map.set('10', makeState({ login: 'alice' }));
    map.set('11', makeState({ login: 'alice' })); // evicts key "10" already
    map.delete('10');

    expect(map.getByLogin('alice')).toBe(map.get('11'));
    expect(map.size).toBe(1);
  });

  it('clear empties both the map and the login index', () => {
    const map = new LiveStateMap();
    map.set('10', makeState({ login: 'alice' }));
    map.clear();

    expect(map.size).toBe(0);
    expect(map.getByLogin('alice')).toBeUndefined();
  });
});
