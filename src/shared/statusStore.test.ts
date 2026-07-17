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

  it('setDiscordReady marks ready with tag and guildName', () => {
    mod.setDiscordReady('Bot#1234', 'MyGuild');
    const { discord } = mod.getStatus(null);
    expect(discord.ready).toBe(true);
    expect(discord.tag).toBe('Bot#1234');
    expect(discord.guildName).toBe('MyGuild');
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
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
    mod.setVoiceDisconnected('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(false);
    expect(voice.channelName).toBeNull();
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('setVoicePlaying sets playing, file, command, source, and lastPlayedAt', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.playing).toBe(true);
    expect(voice.currentFile).toBe('clap.mp3');
    expect(voice.lastCommand).toBe('!clap');
    expect(voice.lastSource).toBe('discord');
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('setVoiceIdle clears playing and currentFile but preserves lastPlayedAt', () => {
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
    mod.setVoiceIdle('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('scopes voice status per guild — one guild playing does not affect another', () => {
    mod.setVoiceConnected('guild-A', 'General');
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
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
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
    mod.clearVoiceStatus('guild-A');
    const { voice } = mod.getStatus('guild-A');
    expect(voice.connected).toBe(false);
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });
});

describe('Twitch channel status', () => {
  it('starts with no channels', () => {
    expect(mod.getStatus(null).twitch).toEqual({});
  });

  it('setTwitchChannel connected records lastConnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    const entry = mod.getStatus(null).twitch['mychan'];
    expect(entry.connected).toBe(true);
    expect(entry.lastConnectedAt).toBeInstanceOf(Date);
    expect(entry.lastDisconnectedAt).toBeNull();
  });

  it('setTwitchChannel disconnected records lastDisconnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannel('mychan', false);
    const entry = mod.getStatus(null).twitch['mychan'];
    expect(entry.connected).toBe(false);
    expect(entry.lastDisconnectedAt).toBeInstanceOf(Date);
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
    const first = mod.getStatus(null).twitch['mychan'].lastConnectedAt;
    mod.setTwitchChannel('mychan', true); // already connected — no change
    expect(mod.getStatus(null).twitch['mychan'].lastConnectedAt).toEqual(first);
  });

  it('setTwitchChannelLive updates isLive for an existing channel', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannelLive('mychan', true);
    expect(mod.getStatus(null).twitch['mychan'].isLive).toBe(true);
    mod.setTwitchChannelLive('mychan', false);
    expect(mod.getStatus(null).twitch['mychan'].isLive).toBe(false);
  });

  it('setTwitchChannelLive is a no-op for unknown channels', () => {
    mod.setTwitchChannelLive('unknown', true);
    expect(mod.getStatus(null).twitch['unknown']).toBeUndefined();
  });
});

describe('TikTok channel status', () => {
  it('starts with no channels', () => {
    expect(mod.getStatus(null).tiktok).toEqual({});
  });

  it('setTikTokChannel connected records state', () => {
    mod.setTikTokChannel('creator1', true);
    expect(mod.getStatus(null).tiktok['creator1'].connected).toBe(true);
    expect(mod.getStatus(null).tiktok['creator1'].lastConnectedAt).toBeInstanceOf(Date);
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
    mod.setDiscordReady('Bot#1234', 'MyGuild');
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
    mod.setVoicePlaying('guild-A', 'clap.mp3', '!clap', 'discord');
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

  it('setTikTokChannel notifies with null (not scoped to one guild)', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.setTikTokChannel('creator1', true);
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
    mod.setDiscordReady('Bot#1234', 'MyGuild');
    expect(first).toHaveBeenCalledWith(null);
    expect(second).toHaveBeenCalledWith(null);
  });

  it('does not register the same listener function twice', () => {
    const listener = vi.fn();
    mod.onStatusChanged(listener);
    mod.onStatusChanged(listener);
    mod.setDiscordReady('Bot#1234', 'MyGuild');
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('getStatus returns shallow copies', () => {
  it('mutating returned discord object does not affect internal state', () => {
    mod.setDiscordReady('Bot#1234', 'MyGuild');
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
