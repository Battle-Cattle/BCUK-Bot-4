import { describe, it, expect, beforeEach, vi } from 'vitest';

let mod: Awaited<typeof import('./statusStore.js')>;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./statusStore.js');
});

describe('Discord status', () => {
  it('starts as not ready', () => {
    expect(mod.getStatus(null).discord.ready).toBe(false);
  });

  it('setDiscordReady marks ready with tag', () => {
    mod.setDiscordReady('Bot#1234');
    const { discord } = mod.getStatus(null);
    expect(discord.ready).toBe(true);
    expect(discord.tag).toBe('Bot#1234');
  });
});

describe('Voice status', () => {
  it('starts disconnected and idle', () => {
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(false);
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('reports a default disconnected/idle status for a null guildId', () => {
    const { voice } = mod.getStatus(null);
    expect(voice.connected).toBe(false);
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('setVoiceConnected marks connected with channelName', () => {
    mod.setVoiceConnected('guild-A', 'General');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(true);
    expect(voice.channelName).toBe('General');
  });

  it('setVoiceDisconnected clears connected, playing, file, and channelName', () => {
    mod.setVoiceConnected('guild-A', 'General');
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    mod.setVoiceDisconnected('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(false);
    expect(voice.channelName).toBeNull();
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('setVoicePlaying sets playing, file, command, source, and lastPlayedAt', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    const { voice } = mod.getStatus('guild-A');
    expect(voice.playing).toBe(true);
    expect(voice.currentFile).toBe('clap.mp3');
    expect(voice.lastCommand).toBe('!clap');
    expect(voice.lastSource).toBe('discord');
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('setVoiceIdle clears playing and currentFile but preserves lastPlayedAt', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    mod.setVoiceIdle('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('records who, from where and which file, and keeps them after playback ends', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'twitch', user: 'user1', channel: 'streamer_one' });
    mod.setVoiceIdle('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect([voice.lastSource, voice.lastUser, voice.lastChannel, voice.lastFile]).toEqual(['twitch', 'user1', 'streamer_one', 'clap.mp3']);
    expect(voice.currentFile).toBeNull();
  });

  it('keeps the last-played fields when the bot leaves voice, and resets them only when the guild is forgotten', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    mod.setVoiceDisconnected('guild-A');
    expect(mod.getStatus('guild-A').voice.lastFile).toBe('clap.mp3');
    expect(mod.getStatus('guild-A').voice.lastUser).toBe('user1');
    mod.clearVoiceStatus('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect([voice.lastFile, voice.lastUser, voice.lastChannel, voice.lastSource, voice.lastCommand]).toEqual([null, null, null, null, null]);
  });

  it('never stores a channel for a Discord or Stream Deck origin, even one forced in past the types', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1', channel: 'mod-secret' } as never);
    expect(mod.getStatus('guild-A').voice.lastChannel).toBeNull();
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'streamdeck', user: 'user1', channel: 'mod-secret' } as never);
    expect(mod.getStatus('guild-A').voice.lastChannel).toBeNull();
  });

  it('overwrites every last-played field on each play, so a later play never shows an earlier one\'s user or channel', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'twitch', user: 'user1', channel: 'streamer_one' });
    mod.setVoicePlaying('guild-A', 'ding.mp3', '!ding', { source: 'streamdeck', user: null });
    const { voice } = mod.getStatus('guild-A');
    expect([voice.lastSource, voice.lastUser, voice.lastChannel, voice.lastFile, voice.lastCommand]).toEqual(['streamdeck', null, null, 'ding.mp3', '!ding']);
  });

  it('puts exactly the agreed voice fields in the status snapshot', () => {
    expect(Object.keys(mod.getStatus('guild-A').voice).sort()).toEqual([
      'channelName', 'connected', 'currentFile', 'lastChannel', 'lastCommand', 'lastFile', 'lastPlayedAt', 'lastSource', 'lastUser', 'playing',
    ]);
  });

  it('scopes voice status per guild — one guild playing does not affect another', () => {
    mod.setVoiceConnected('guild-A', 'General');
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    const { voice: voiceB } = mod.getStatus('guild-B');
    expect(voiceB.connected).toBe(false);
    expect(voiceB.playing).toBe(false);
    expect(voiceB.currentFile).toBeNull();
    const { voice: voiceA } = mod.getStatus('guild-A');
    expect(voiceA.connected).toBe(true);
    expect(voiceA.playing).toBe(true);
    expect(voiceA.currentFile).toBe('clap.mp3');
  });

  it('clearVoiceStatus removes a guild entirely, resetting it to default on next read', () => {
    mod.setVoiceConnected('guild-A', 'General');
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    mod.clearVoiceStatus('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(false);
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });
});

describe('cleanDisplayText', () => {
  it.each([
    ['plain text is kept', 'user1', 'user1'],
    ['a right-to-left override is removed', 'user\u202E1', 'user 1'],
    ['control characters and newlines become spaces and collapse', 'a\nb\u0000c\t d', 'a b c d'],
    ['line and paragraph separators are removed', 'a\u2028b\u2029c', 'a b c'],
    ['edges are trimmed', '  user1  ', 'user1'],
    ['whitespace only is null', ' \n\t ', null],
    ['an empty string is null', '', null],
    ['null stays null', null, null],
    ['undefined is null', undefined, null],
  ])('%s', (_name, input, expected) => {
    expect(mod.cleanDisplayText(input as string | null | undefined)).toBe(expected);
  });

  it('caps the length in code points, never cutting an emoji in half', () => {
    const emoji = '\u{1F600}'.repeat(70);
    const cleaned = mod.cleanDisplayText(emoji);
    expect(Array.from(cleaned ?? '')).toHaveLength(64);
    expect(cleaned).toBe('\u{1F600}'.repeat(64));
    expect(mod.cleanDisplayText('x'.repeat(200))).toHaveLength(64);
  });

  it('cleans the user and channel on the way into the store', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'twitch', user: 'user\u202E1\n', channel: ' streamer_one ' });
    const { voice } = mod.getStatus('guild-A');
    expect([voice.lastUser, voice.lastChannel]).toEqual(['user 1', 'streamer_one']);
  });
});

describe('Twitch channel status', () => {
  it('starts with no channels', () => {
    expect(mod.getStatus(null).twitch).toEqual({});
  });

  it('setTwitchChannel connected records lastConnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    const entry = mod.getStatus(null).twitch['mychan'];
    expect(entry!.connected).toBe(true);
    expect(entry!.lastConnectedAt).toBeInstanceOf(Date);
    expect(entry!.lastDisconnectedAt).toBeNull();
  });

  it('setTwitchChannel disconnected records lastDisconnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannel('mychan', false);
    const entry = mod.getStatus(null).twitch['mychan'];
    expect(entry!.connected).toBe(false);
    expect(entry!.lastDisconnectedAt).toBeInstanceOf(Date);
  });

  it('strips leading # from channel name', () => {
    mod.setTwitchChannel('#mychan', true);
    expect(mod.getStatus(null).twitch['mychan']).toBeDefined();
  });

  it('normalises to lowercase', () => {
    mod.setTwitchChannel('MyChan', true);
    expect(mod.getStatus(null).twitch['mychan']).toBeDefined();
  });

  it('reconnecting does not overwrite lastConnectedAt again', () => {
    mod.setTwitchChannel('mychan', true);
    const first = mod.getStatus(null).twitch['mychan']!.lastConnectedAt;
    mod.setTwitchChannel('mychan', true); // already connected — no change
    expect(mod.getStatus(null).twitch['mychan']!.lastConnectedAt).toEqual(first);
  });

  it('setTwitchChannelLive updates isLive for an existing channel', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannelLive('mychan', true);
    expect(mod.getStatus(null).twitch['mychan']!.isLive).toBe(true);
    mod.setTwitchChannelLive('mychan', false);
    expect(mod.getStatus(null).twitch['mychan']!.isLive).toBe(false);
  });

  it('setTwitchChannelLive is a no-op for unknown channels', () => {
    mod.setTwitchChannelLive('unknown', true);
    expect(mod.getStatus(null).twitch['unknown']).toBeUndefined();
  });

  it('trims stray whitespace so it keys the same channel as an already-normalized name', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannel(' mychan ', false);
    expect(mod.getStatus(null).twitch['mychan']!.connected).toBe(false);
    expect(mod.getStatus(null).twitch[' mychan ']).toBeUndefined();
  });

  it('setTwitchChannel is a no-op for a name that fails Twitch login validation', () => {
    mod.setTwitchChannel('a', true);
    expect(mod.getStatus(null).twitch['a']).toBeUndefined();
  });

  it('setTwitchChannelLive is a no-op for a name that fails Twitch login validation', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannelLive('a', true);
    expect(mod.getStatus(null).twitch['mychan']!.isLive).toBe(false);
  });
});

describe('Twitch live-check time (liveCheckedAt)', () => {
  it('is null for a new channel, until the monitor has checked it', () => {
    mod.setTwitchChannel('mychan', true);
    expect(mod.getStatus(null).twitch['mychan']!.liveCheckedAt).toBeNull();
  });

  it('markTwitchChannelsLiveChecked stamps every tracked channel it is given, and leaves the others null', () => {
    mod.setTwitchChannel('chan_one', true);
    mod.setTwitchChannel('chan_two', true);
    mod.setTwitchChannel('chan_three', true);

    mod.markTwitchChannelsLiveChecked(['chan_one', 'chan_two']);

    const { twitch } = mod.getStatus(null);
    expect(twitch['chan_one']!.liveCheckedAt).toBeInstanceOf(Date);
    expect(twitch['chan_two']!.liveCheckedAt).toBeInstanceOf(Date);
    expect(twitch['chan_three']!.liveCheckedAt).toBeNull();
  });

  it('advances on every check, whether or not isLive changed', () => {
    vi.useFakeTimers();
    try {
      mod.setTwitchChannel('mychan', true);
      mod.setTwitchChannelLive('mychan', true);
      vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
      mod.markTwitchChannelsLiveChecked(['mychan']);
      expect(mod.getStatus(null).twitch['mychan']!.liveCheckedAt).toEqual(new Date('2026-11-23T10:00:00Z'));

      vi.setSystemTime(new Date('2026-11-23T10:01:00Z'));
      mod.markTwitchChannelsLiveChecked(['mychan']);
      expect(mod.getStatus(null).twitch['mychan']!.liveCheckedAt).toEqual(new Date('2026-11-23T10:01:00Z'));
      expect(mod.getStatus(null).twitch['mychan']!.isLive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes logins, and skips unknown channels and names that fail Twitch login validation', () => {
    mod.setTwitchChannel('mychan', true);

    mod.markTwitchChannelsLiveChecked(['#MyChan', 'unknown', 'a']);

    const { twitch } = mod.getStatus(null);
    expect(twitch['mychan']!.liveCheckedAt).toBeInstanceOf(Date);
    expect(twitch['unknown']).toBeUndefined();
    expect(twitch['a']).toBeUndefined();
  });

  it('notifies once with null for a batch, and not at all when no tracked channel was updated', () => {
    mod.setTwitchChannel('chan_one', true);
    mod.setTwitchChannel('chan_two', true);
    const listener = vi.fn();
    mod.onStatusChanged(listener);

    mod.markTwitchChannelsLiveChecked(['chan_one', 'chan_two']);
    expect(listener).toHaveBeenCalledExactlyOnceWith(null);

    listener.mockClear();
    mod.markTwitchChannelsLiveChecked(['unknown']);
    mod.markTwitchChannelsLiveChecked([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not change any other field of the channel', () => {
    mod.setTwitchChannel('mychan', true);
    const before = { ...mod.getStatus(null).twitch['mychan']! };

    mod.markTwitchChannelsLiveChecked(['mychan']);

    const { liveCheckedAt: _checked, ...rest } = mod.getStatus(null).twitch['mychan']!;
    const { liveCheckedAt: _was, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
  });
});

describe('onStatusChanged', () => {
  it('is not called before any mutator runs', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('setDiscordReady notifies with null (not scoped to one guild)', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setDiscordReady('Bot#1234');
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('setVoiceConnected notifies with the guildId', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setVoiceConnected('guild-A', 'General');
    expect(listener).toHaveBeenCalledWith('guild-A');
  });

  it('setVoiceDisconnected notifies with the guildId', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setVoiceDisconnected('guild-A');
    expect(listener).toHaveBeenCalledWith('guild-A');
  });

  it('setVoicePlaying notifies with the guildId', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', { source: 'discord', user: 'user1' });
    expect(listener).toHaveBeenCalledWith('guild-A');
  });

  it('setVoiceIdle notifies with the guildId', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setVoiceIdle('guild-A');
    expect(listener).toHaveBeenCalledWith('guild-A');
  });

  it('clearVoiceStatus notifies with the guildId', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.clearVoiceStatus('guild-A');
    expect(listener).toHaveBeenCalledWith('guild-A');
  });

  it('setTwitchChannel notifies with null (not scoped to one guild)', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setTwitchChannel('mychan', true);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('setTwitchChannelLive notifies with null when the channel is tracked', () => {
    mod.setTwitchChannel('mychan', true);
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setTwitchChannelLive('mychan', true);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('setTwitchChannelLive does not notify for an unknown channel', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setTwitchChannelLive('unknown', true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every registered listener, not just the most recently registered one', () => {
    const first = vi.fn();
    const second = vi.fn();
    mod.onStatusChanged(first);
    mod.onStatusChanged(second);
    mod.setDiscordReady('Bot#1234');
    expect(first).toHaveBeenCalledWith(null);
    expect(second).toHaveBeenCalledWith(null);
  });

  it('does not register the same listener function twice', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.onStatusChanged(listener);
    mod.setDiscordReady('Bot#1234');
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('getStatus returns shallow copies', () => {
  it('mutating returned discord object does not affect internal state', () => {
    mod.setDiscordReady('Bot#1234');
    const snapshot = mod.getStatus(null);
    (snapshot.discord as Record<string, unknown>).tag = 'mutated';
    expect(mod.getStatus(null).discord.tag).toBe('Bot#1234');
  });

  it('mutating returned voice object does not affect internal state', () => {
    mod.setVoiceConnected('guild-A', 'General');
    const snapshot = mod.getStatus('guild-A');
    (snapshot.voice as Record<string, unknown>).channelName = 'mutated';
    expect(mod.getStatus('guild-A').voice.channelName).toBe('General');
  });
});
