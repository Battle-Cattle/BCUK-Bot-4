import { describe, it, expect, beforeEach, vi } from 'vitest';

let mod: Awaited<typeof import('./statusStore.js')>;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./statusStore.js');
});

describe('Discord status', () => {
  it('starts as not ready', () => {
    expect(mod.getStatus().discord.ready).toBe(false);
  });

  it('setDiscordReady marks ready with tag and guildName', () => {
    mod.setDiscordReady('Bot#1234', 'MyGuild');
    const { discord } = mod.getStatus();
    expect(discord.ready).toBe(true);
    expect(discord.tag).toBe('Bot#1234');
    expect(discord.guildName).toBe('MyGuild');
  });
});

describe('Voice status', () => {
  it('starts disconnected and idle', () => {
    const { voice } = mod.getStatus();
    expect(voice.connected).toBe(false);
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('setVoiceConnected marks connected with channelName', () => {
    mod.setVoiceConnected('General');
    const { voice } = mod.getStatus();
    expect(voice.connected).toBe(true);
    expect(voice.channelName).toBe('General');
  });

  it('setVoiceDisconnected clears connected, playing, file, and channelName', () => {
    mod.setVoiceConnected('General');
    mod.setVoicePlaying('clap.mp3', '!clap', 'discord');
    mod.setVoiceDisconnected();
    const { voice } = mod.getStatus();
    expect(voice.connected).toBe(false);
    expect(voice.channelName).toBeNull();
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
  });

  it('setVoicePlaying sets playing, file, command, source, and lastPlayedAt', () => {
    mod.setVoicePlaying('clap.mp3', '!clap', 'discord');
    const { voice } = mod.getStatus();
    expect(voice.playing).toBe(true);
    expect(voice.currentFile).toBe('clap.mp3');
    expect(voice.lastCommand).toBe('!clap');
    expect(voice.lastSource).toBe('discord');
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });

  it('setVoiceIdle clears playing and currentFile but preserves lastPlayedAt', () => {
    mod.setVoicePlaying('clap.mp3', '!clap', 'discord');
    mod.setVoiceIdle();
    const { voice } = mod.getStatus();
    expect(voice.playing).toBe(false);
    expect(voice.currentFile).toBeNull();
    expect(voice.lastPlayedAt).toBeInstanceOf(Date);
  });
});

describe('Twitch channel status', () => {
  it('starts with no channels', () => {
    expect(mod.getStatus().twitch).toEqual({});
  });

  it('setTwitchChannel connected records lastConnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    const entry = mod.getStatus().twitch['mychan'];
    expect(entry.connected).toBe(true);
    expect(entry.lastConnectedAt).toBeInstanceOf(Date);
    expect(entry.lastDisconnectedAt).toBeNull();
  });

  it('setTwitchChannel disconnected records lastDisconnectedAt', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannel('mychan', false);
    const entry = mod.getStatus().twitch['mychan'];
    expect(entry.connected).toBe(false);
    expect(entry.lastDisconnectedAt).toBeInstanceOf(Date);
  });

  it('strips leading # from channel name', () => {
    mod.setTwitchChannel('#mychan', true);
    expect(mod.getStatus().twitch['mychan']).toBeDefined();
  });

  it('normalises to lowercase', () => {
    mod.setTwitchChannel('MyChan', true);
    expect(mod.getStatus().twitch['mychan']).toBeDefined();
  });

  it('reconnecting does not overwrite lastConnectedAt again', () => {
    mod.setTwitchChannel('mychan', true);
    const first = mod.getStatus().twitch['mychan'].lastConnectedAt;
    mod.setTwitchChannel('mychan', true); // already connected — no change
    expect(mod.getStatus().twitch['mychan'].lastConnectedAt).toEqual(first);
  });

  it('setTwitchChannelLive updates isLive for an existing channel', () => {
    mod.setTwitchChannel('mychan', true);
    mod.setTwitchChannelLive('mychan', true);
    expect(mod.getStatus().twitch['mychan'].isLive).toBe(true);
    mod.setTwitchChannelLive('mychan', false);
    expect(mod.getStatus().twitch['mychan'].isLive).toBe(false);
  });

  it('setTwitchChannelLive is a no-op for unknown channels', () => {
    mod.setTwitchChannelLive('unknown', true);
    expect(mod.getStatus().twitch['unknown']).toBeUndefined();
  });
});

describe('TikTok channel status', () => {
  it('starts with no channels', () => {
    expect(mod.getStatus().tiktok).toEqual({});
  });

  it('setTikTokChannel connected records state', () => {
    mod.setTikTokChannel('creator1', true);
    expect(mod.getStatus().tiktok['creator1'].connected).toBe(true);
    expect(mod.getStatus().tiktok['creator1'].lastConnectedAt).toBeInstanceOf(Date);
  });
});

describe('getStatus returns shallow copies', () => {
  it('mutating returned discord object does not affect internal state', () => {
    mod.setDiscordReady('Bot#1234', 'MyGuild');
    const snapshot = mod.getStatus();
    (snapshot.discord as Record<string, unknown>).tag = 'mutated';
    expect(mod.getStatus().discord.tag).toBe('Bot#1234');
  });

  it('mutating returned voice object does not affect internal state', () => {
    mod.setVoiceConnected('General');
    const snapshot = mod.getStatus();
    (snapshot.voice as Record<string, unknown>).channelName = 'mutated';
    expect(mod.getStatus().voice.channelName).toBe('General');
  });
});
