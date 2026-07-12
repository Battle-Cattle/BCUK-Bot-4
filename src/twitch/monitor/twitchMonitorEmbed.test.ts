import { describe, it, expect, vi } from 'vitest';

vi.mock('discord.js', () => ({
  EmbedBuilder: class MockEmbedBuilder {
    private _data: Record<string, unknown> = {};
    setTitle(t: string) { this._data.title = t; return this; }
    setURL(u: string) { this._data.url = u; return this; }
    setColor(c: number) { this._data.color = c; return this; }
    addFields(...fields: unknown[]) { this._data.fields = fields; return this; }
    setImage(u: string) { this._data.image = u; return this; }
    getData() { return this._data; }
  },
}));

vi.mock('../twitchApi', () => ({}));
vi.mock('./twitchMonitorTypes', () => ({}));

import {
  getStreamUrl,
  getThumbnailUrl,
  buildEmbedPreview,
  parseHexColor,
  buildEmbed,
  templateVars,
  buildMessagePreview,
} from './twitchMonitorEmbed';
import type { TwitchStream } from '../twitchApi';
import type { LiveState } from './twitchMonitorTypes';

function makeStream(overrides: Partial<TwitchStream> = {}): TwitchStream {
  return {
    user_id: '123',
    user_login: 'streamer1',
    game_name: 'Minecraft',
    title: 'Playing Minecraft',
    thumbnail_url: 'https://thumb.tv/{width}x{height}.jpg',
    type: 'live',
    ...overrides,
  };
}

describe('getStreamUrl', () => {
  it('returns the correct Twitch channel URL', () => {
    expect(getStreamUrl('streamer1')).toBe('https://www.twitch.tv/streamer1');
  });
});

describe('getThumbnailUrl', () => {
  it('replaces {width} and {height} placeholders', () => {
    const stream = makeStream({ thumbnail_url: 'https://thumb.tv/{width}x{height}.jpg' });
    expect(getThumbnailUrl(stream)).toBe('https://thumb.tv/640x360.jpg');
  });
});

describe('parseHexColor', () => {
  it('parses a valid hex string with # prefix', () => {
    expect(parseHexColor('#9146FF')).toBe(0x9146ff);
  });

  it('parses a valid hex string without # prefix', () => {
    expect(parseHexColor('FF0000')).toBe(0xff0000);
  });

  it('is case-insensitive', () => {
    expect(parseHexColor('#ffffff')).toBe(0xffffff);
    expect(parseHexColor('#FFFFFF')).toBe(0xffffff);
  });

  it('returns default Twitch purple for invalid input', () => {
    expect(parseHexColor('not-a-color')).toBe(0x9146ff);
  });

  it('returns default for strings that are too short', () => {
    expect(parseHexColor('#FFF')).toBe(0x9146ff);
  });

  it('trims whitespace before parsing', () => {
    expect(parseHexColor('  #FF0000  ')).toBe(0xff0000);
  });
});

describe('buildEmbedPreview', () => {
  it('populates title, url, color, imageUrl from stream data', () => {
    const stream = makeStream();
    const preview = buildEmbedPreview(stream);
    expect(preview.title).toBe('Playing Minecraft');
    expect(preview.url).toBe('https://www.twitch.tv/streamer1');
    expect(preview.color).toBe('#9146FF');
    expect(preview.imageUrl).toBe('https://thumb.tv/640x360.jpg');
  });

  it('includes a Game field', () => {
    const stream = makeStream({ game_name: 'Chess' });
    const preview = buildEmbedPreview(stream);
    expect(preview.fields).toContainEqual({ name: 'Game', value: 'Chess' });
  });

  it('uses "Unknown" when game_name is empty', () => {
    const preview = buildEmbedPreview(makeStream({ game_name: '' }));
    expect(preview.fields).toContainEqual({ name: 'Game', value: 'Unknown' });
  });

  it('adds a MultiTwitch field when multitwitchUrl is provided', () => {
    const preview = buildEmbedPreview(makeStream(), 'https://multitwitch.tv/a/b');
    expect(preview.fields).toContainEqual({ name: 'MultiTwitch', value: 'https://multitwitch.tv/a/b' });
  });

  it('does not add a MultiTwitch field when url is omitted', () => {
    const preview = buildEmbedPreview(makeStream());
    expect(preview.fields.map((f) => f.name)).not.toContain('MultiTwitch');
  });
});

describe('templateVars', () => {
  it('returns streamer, game, title, and url', () => {
    const stream = makeStream({ game_name: 'Chess', title: 'Playing Chess' });
    const vars = templateVars('alice', stream);
    expect(vars).toEqual({
      streamer: 'alice',
      game: 'Chess',
      title: 'Playing Chess',
      url: 'https://www.twitch.tv/alice',
    });
  });

  it('falls back to "Unknown" for empty game_name', () => {
    const vars = templateVars('alice', makeStream({ game_name: '' }));
    expect(vars.game).toBe('Unknown');
  });
});

describe('buildEmbed', () => {
  it('returns an EmbedBuilder with title and URL set', () => {
    const stream = makeStream();
    const embed = buildEmbed(stream) as unknown as { getData(): Record<string, unknown> };
    const data = embed.getData();
    expect(data.title).toBe('Playing Minecraft');
    expect(data.url).toBe('https://www.twitch.tv/streamer1');
  });

  it('sets the Twitch purple color', () => {
    const embed = buildEmbed(makeStream()) as unknown as { getData(): Record<string, unknown> };
    expect(embed.getData().color).toBe(0x9146ff);
  });
});

describe('buildMessagePreview', () => {
  function makeLiveState(overrides: Partial<LiveState> = {}): LiveState {
    const stream = makeStream();
    return {
      streamerId: 1,
      groupId: 1,
      login: 'streamer1',
      messageId: null,
      channelId: null,
      currentGame: 'Minecraft',
      title: 'Playing Minecraft',
      currentStream: stream,
      offlineTimer: null,
      group: {
        id: 1,
        live_message: 'Watch {streamer} at {url}',
        new_game_message: '{streamer} switched to {game}',
        discord_channel_id: 'chan-1',
        delete_old_posts: false,
      } as any,
      ...overrides,
    } as LiveState;
  }

  it('uses live_message template for live_message key', () => {
    const state = makeLiveState();
    const preview = buildMessagePreview(state, 'live_message', { url: null });
    expect(preview.content).toContain('https://www.twitch.tv/streamer1');
  });

  it('uses new_game_message template for new_game_message key', () => {
    const state = makeLiveState();
    const preview = buildMessagePreview(state, 'new_game_message', { url: null });
    expect(preview.content).toContain('Minecraft');
  });

  it('passes multitwitchUrl through to the embed', () => {
    const state = makeLiveState();
    const preview = buildMessagePreview(state, 'live_message', { url: 'https://multitwitch.tv/a/b' });
    expect(preview.embed.fields.map((f) => f.name)).toContain('MultiTwitch');
  });

  it('does not include MultiTwitch field when url is null', () => {
    const state = makeLiveState();
    const preview = buildMessagePreview(state, 'live_message', { url: null });
    expect(preview.embed.fields.map((f) => f.name)).not.toContain('MultiTwitch');
  });

  it('leaves an unknown placeholder as literal {key} text instead of blanking it', () => {
    const state = makeLiveState({
      group: {
        id: 1,
        live_message: 'Watch {streamer} play {typo_field}',
        new_game_message: '{streamer} switched to {game}',
        discord_channel_id: 'chan-1',
        delete_old_posts: false,
      } as any,
    });
    const preview = buildMessagePreview(state, 'live_message', { url: null });
    expect(preview.content).toBe('Watch streamer1 play {typo_field}');
  });
});
