import { getOrCreate } from './mapUtils';

/** Live connection and stream status for a single Twitch or TikTok channel. */
export interface ChannelStatus {
  connected: boolean;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  isLive: boolean;
}

/** Live voice-connection and playback status for a single guild. */
export interface VoiceStatus {
  connected: boolean;
  channelName: string | null;
  playing: boolean;
  currentFile: string | null;
  lastCommand: string | null;
  lastSource: string | null;
  lastPlayedAt: Date | null;
}

/** Returns a fresh, disconnected/idle voice status record. */
function defaultVoiceStatus(): VoiceStatus {
  return {
    connected: false,
    channelName: null,
    playing: false,
    currentFile: null,
    lastCommand: null,
    lastSource: null,
    lastPlayedAt: null,
  };
}

const state = {
  discord: {
    ready: false,
    tag: null as string | null,
    guildName: null as string | null,
  },
  voice: new Map<string, VoiceStatus>(),
  twitch: new Map<string, ChannelStatus>(),
  tiktok: new Map<string, ChannelStatus>(),
};

/** Returns a guild's voice status, creating a default (disconnected/idle) record on first use. */
function getVoiceState(guildId: string): VoiceStatus {
  return getOrCreate(state.voice, guildId, defaultVoiceStatus);
}

/**
 * Removes a guild's voice status entirely, e.g. when the bot leaves the guild.
 * @param guildId - Guild whose voice status should be forgotten.
 */
export function clearVoiceStatus(guildId: string): void {
  state.voice.delete(guildId);
}

/** Marks the Discord bot as ready with its tag and guild name. */
export function setDiscordReady(tag: string, guildName: string): void {
  state.discord.ready = true;
  state.discord.tag = tag;
  state.discord.guildName = guildName;
}

/**
 * Records that the bot has joined a voice channel in the given guild.
 * @param guildId - Guild the bot connected in.
 * @param channelName - Name of the voice channel joined.
 */
export function setVoiceConnected(guildId: string, channelName: string): void {
  const voice = getVoiceState(guildId);
  voice.connected = true;
  voice.channelName = channelName;
}

/**
 * Records that the bot has left the given guild's voice channel and clears its playback state.
 * @param guildId - Guild the bot disconnected from.
 */
export function setVoiceDisconnected(guildId: string): void {
  const voice = getVoiceState(guildId);
  voice.connected = false;
  voice.channelName = null;
  voice.playing = false;
  voice.currentFile = null;
}

/**
 * Updates a guild's voice state to reflect that a file is now playing there.
 * @param guildId - Guild the sound is playing in.
 * @param file - File name being played.
 * @param command - Trigger command that caused playback.
 * @param source - Where the command came from (e.g. 'discord', 'twitch', 'streamdeck').
 */
export function setVoicePlaying(guildId: string, file: string, command: string, source: string): void {
  const voice = getVoiceState(guildId);
  voice.playing = true;
  voice.currentFile = file;
  voice.lastCommand = command;
  voice.lastSource = source;
  voice.lastPlayedAt = new Date();
}

/**
 * Clears the playing flag and current file for a guild when its playback finishes.
 * @param guildId - Guild whose playback went idle.
 */
export function setVoiceIdle(guildId: string): void {
  const voice = getVoiceState(guildId);
  voice.playing = false;
  voice.currentFile = null;
}

/** Returns a fresh, disconnected channel status record with no connection history yet. */
function defaultChannelStatus(): ChannelStatus {
  return { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false };
}

function updateChannel(map: Map<string, ChannelStatus>, key: string, connected: boolean): void {
  const existing = getOrCreate(map, key, defaultChannelStatus);
  if (connected && !existing.connected) existing.lastConnectedAt = new Date();
  if (!connected && existing.connected) existing.lastDisconnectedAt = new Date();
  existing.connected = connected;
}

/** Updates the connected state for a Twitch channel. */
export function setTwitchChannel(channel: string, connected: boolean): void {
  updateChannel(state.twitch, channel.toLowerCase().replace(/^#/, ''), connected);
}

/** Updates the connected state for a TikTok channel. */
export function setTikTokChannel(username: string, connected: boolean): void {
  updateChannel(state.tiktok, username, connected);
}

/** Updates the isLive flag for a Twitch channel. No-ops if the channel isn't tracked yet. */
export function setTwitchChannelLive(login: string, isLive: boolean): void {
  const key = login.toLowerCase().replace(/^#/, '');
  const existing = state.twitch.get(key);
  if (existing) existing.isLive = isLive;
}

/**
 * Returns a snapshot of the current bot status (Discord, voice for the given
 * guild, Twitch channels, TikTok channels). Voice status is scoped to a
 * single guild so a viewer of one guild's dashboard never sees another
 * guild's now-playing info; a null guildId (no guild selected yet) reports a
 * default disconnected/idle voice status.
 *
 * @param guildId - Guild to read voice status for, or null if none is selected.
 */
export function getStatus(guildId: string | null) {
  return {
    discord: { ...state.discord },
    voice: { ...((guildId ? state.voice.get(guildId) : undefined) ?? defaultVoiceStatus()) },
    twitch: Object.fromEntries(state.twitch) as Record<string, ChannelStatus>,
    tiktok: Object.fromEntries(state.tiktok) as Record<string, ChannelStatus>,
  };
}
