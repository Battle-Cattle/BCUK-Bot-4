import { getOrCreate } from './mapUtils';

// Registered by the web layer (via onStatusChanged) so every mutator below can push a live
// SSE update without this module importing anything from web/ — same rationale as the
// runtime-injection registries used for EventSub's overlay/companion/alert pushes. A Set of
// listeners (not a single slot like those single-consumer registries) since this module is
// mutated from many unrelated call sites across the bot — an accidental second registration
// here should gain a subscriber, not silently drop the first one.
const statusChangeListeners = new Set<(guildId: string | null) => void>();

/**
 * Registers a callback invoked after every status mutation below, so the web layer can push
 * live dashboard updates without this module depending on it. Adds to the set of registered
 * listeners — every registered listener is notified on each change; none are dropped by a
 * later registration.
 * @param listener - Called with the guild whose voice status changed, or null for a change
 *   that isn't scoped to one guild (Discord bot state, Twitch/TikTok channel state).
 */
export function onStatusChanged(listener: (guildId: string | null) => void): void {
  statusChangeListeners.add(listener);
}

/** Invokes every registered status-change listener (see {@link onStatusChanged}) with `guildId`. */
function notifyStatusChanged(guildId: string | null): void {
  for (const listener of statusChangeListeners) listener(guildId);
}

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
 * Removes a guild's voice status entirely, e.g. when the bot leaves the guild. Notifies the
 * registered status-change listener (see {@link onStatusChanged}) for this guild.
 * @param guildId - Guild whose voice status should be forgotten.
 */
export function clearVoiceStatus(guildId: string): void {
  state.voice.delete(guildId);
  notifyStatusChanged(guildId);
}

/**
 * Marks the Discord bot as ready with its tag and guild name. Notifies the registered
 * status-change listener (see {@link onStatusChanged}) with `null` since this isn't scoped
 * to one guild.
 */
export function setDiscordReady(tag: string, guildName: string): void {
  state.discord.ready = true;
  state.discord.tag = tag;
  state.discord.guildName = guildName;
  notifyStatusChanged(null);
}

/**
 * Records that the bot has joined a voice channel in the given guild. Notifies the registered
 * status-change listener (see {@link onStatusChanged}) for this guild.
 * @param guildId - Guild the bot connected in.
 * @param channelName - Name of the voice channel joined.
 */
export function setVoiceConnected(guildId: string, channelName: string): void {
  const voice = getVoiceState(guildId);
  voice.connected = true;
  voice.channelName = channelName;
  notifyStatusChanged(guildId);
}

/**
 * Records that the bot has left the given guild's voice channel and clears its playback state.
 * Notifies the registered status-change listener (see {@link onStatusChanged}) for this guild.
 * @param guildId - Guild the bot disconnected from.
 */
export function setVoiceDisconnected(guildId: string): void {
  const voice = getVoiceState(guildId);
  voice.connected = false;
  voice.channelName = null;
  voice.playing = false;
  voice.currentFile = null;
  notifyStatusChanged(guildId);
}

/**
 * Updates a guild's voice state to reflect that a file is now playing there. Notifies the
 * registered status-change listener (see {@link onStatusChanged}) for this guild.
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
  notifyStatusChanged(guildId);
}

/**
 * Clears the playing flag and current file for a guild when its playback finishes. Notifies
 * the registered status-change listener (see {@link onStatusChanged}) for this guild.
 * @param guildId - Guild whose playback went idle.
 */
export function setVoiceIdle(guildId: string): void {
  const voice = getVoiceState(guildId);
  voice.playing = false;
  voice.currentFile = null;
  notifyStatusChanged(guildId);
}

/** Returns a fresh, disconnected channel status record with no connection history yet. */
function defaultChannelStatus(): ChannelStatus {
  return { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false };
}

/**
 * Updates a channel's connected flag within `map`, creating a default status
 * record on first use and stamping `lastConnectedAt`/`lastDisconnectedAt`
 * whenever the connected state actually transitions.
 *
 * @param map - The Twitch or TikTok channel-status map to update.
 * @param key - Channel key to update.
 * @param connected - New connected state for the channel.
 */
function updateChannel(map: Map<string, ChannelStatus>, key: string, connected: boolean): void {
  const existing = getOrCreate(map, key, defaultChannelStatus);
  if (connected && !existing.connected) existing.lastConnectedAt = new Date();
  if (!connected && existing.connected) existing.lastDisconnectedAt = new Date();
  existing.connected = connected;
}

/**
 * Updates the connected state for a Twitch channel. Notifies the registered status-change
 * listener (see {@link onStatusChanged}) with `null`, since channel state isn't scoped to
 * one guild.
 */
export function setTwitchChannel(channel: string, connected: boolean): void {
  updateChannel(state.twitch, channel.toLowerCase().replace(/^#/, ''), connected);
  notifyStatusChanged(null);
}

/**
 * Updates the connected state for a TikTok channel. Notifies the registered status-change
 * listener (see {@link onStatusChanged}) with `null`, since channel state isn't scoped to
 * one guild.
 */
export function setTikTokChannel(username: string, connected: boolean): void {
  updateChannel(state.tiktok, username, connected);
  notifyStatusChanged(null);
}

/**
 * Updates the isLive flag for a Twitch channel. No-ops (including no notification) if the
 * channel isn't tracked yet; otherwise notifies the registered status-change listener (see
 * {@link onStatusChanged}) with `null`, since channel state isn't scoped to one guild.
 */
export function setTwitchChannelLive(login: string, isLive: boolean): void {
  const key = login.toLowerCase().replace(/^#/, '');
  const existing = state.twitch.get(key);
  if (existing) {
    existing.isLive = isLive;
    notifyStatusChanged(null);
  }
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
