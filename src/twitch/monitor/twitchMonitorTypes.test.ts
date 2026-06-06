import { describe, it, expect } from 'vitest';
import type { DbStreamGroup, DbStreamerFull } from '../../db';
import type { TwitchStream } from '../twitchApi';
import { makeLiveState } from './twitchMonitorTypes';

function makeGroup(overrides: Partial<DbStreamGroup> = {}): DbStreamGroup {
  return {
    id: 1,
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
