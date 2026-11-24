import { getOrCreate } from './mapUtils';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';

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
 *   that isn't scoped to one guild (Discord bot state, Twitch channel state).
 */
export function onStatusChanged(listener: (guildId: string | null) => void): void {
  statusChangeListeners.add(listener);
}

/**
 * Invokes every registered status-change listener (see {@link onStatusChanged}) with `guildId`.
 * @param guildId - Guild whose voice status changed, or null for a change not scoped to one guild.
 */
function notifyStatusChanged(guildId: string | null): void {
  for (const listener of statusChangeListeners) listener(guildId);
}

/** Live connection and stream status for a single Twitch channel. */
export interface ChannelStatus {
  connected: boolean;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  isLive: boolean;
  /** When the Twitch monitor last successfully checked this channel's live state (live or offline, changed or not); null before the first check. A stalled monitor leaves this behind while `isLive` keeps its last value. */
  liveCheckedAt: Date | null;
}

/** Live voice-connection and playback status for a single guild. */
export interface VoiceStatus {
  connected: boolean;
  channelName: string | null;
  playing: boolean;
  currentFile: string | null;
  lastCommand: string | null;
  lastSource: PlaySource | null;
  lastPlayedAt: Date | null;
  /** File name of the last sound played, kept after playback ends (`currentFile` is only set while playing). */
  lastFile: string | null;
  /** Display name of whoever triggered the last sound; null when unknown. Cleaned by {@link cleanDisplayText}. */
  lastUser: string | null;
  /** Twitch channel the last sound was triggered from; null for every other source (never a Discord channel). */
  lastChannel: string | null;
}

/** Where a sound's trigger came from. */
export type PlaySource = 'discord' | 'twitch' | 'streamdeck';

/**
 * Who triggered a sound and from where. Discriminated on `source` so the privacy rule lives in the type: only a
 * Twitch origin carries a channel (public); a Discord text channel's name could be private and a Stream Deck has none.
 */
export type PlayOrigin =
  | { source: 'twitch'; user: string | null; channel: string | null }
  | { source: 'discord' | 'streamdeck'; user: string | null; channel?: never };

/** Longest user or channel text kept, in code points: a display name is free text and ends up on every dashboard. */
const MAX_DISPLAY_TEXT = 64;

/**
 * Cleans user-controlled text before it reaches the status payload: removes control, bidirectional-control and
 * line/paragraph-separator characters, collapses whitespace, trims, and caps the length in code points (never in UTF-16
 * units, which could cut an emoji in half).
 * @param value - Raw display name or channel name, or null/undefined when unknown.
 * @returns The cleaned text, or null when nothing is left.
 */
export function cleanDisplayText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const capped = Array.from(cleaned).slice(0, MAX_DISPLAY_TEXT).join('').trim();
  return capped === '' ? null : capped;
}

/**
 * Returns a fresh, disconnected/idle voice status record.
 * @returns A new voice status with nothing connected or playing.
 */
function defaultVoiceStatus(): VoiceStatus {
  return {
    connected: false,
    channelName: null,
    playing: false,
    currentFile: null,
    lastCommand: null,
    lastSource: null,
    lastPlayedAt: null,
    lastFile: null,
    lastUser: null,
    lastChannel: null,
  };
}

const state = {
  discord: {
    ready: false,
    tag: null as string | null,
  },
  voice: new Map<string, VoiceStatus>(),
  twitch: new Map<string, ChannelStatus>(),
};

/**
 * Returns a guild's voice status, creating a default (disconnected/idle) record on first use.
 * @param guildId - Discord snowflake of the guild.
 * @returns The guild's live (mutable) voice status record.
 */
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
 * Marks the Discord bot as ready with its tag. Notifies the registered status-change
 * listener (see {@link onStatusChanged}) with `null` since this isn't scoped to one guild.
 * @param tag - The bot user's Discord tag, e.g. `BCUKBot#1234`.
 */
export function setDiscordReady(tag: string): void {
  state.discord.ready = true;
  state.discord.tag = tag;
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
 * @param origin - Who triggered it and from where. All the `last*` fields are written in this one call, overwriting
 *   anything missing with null, so a later play never shows an earlier play's user or channel. The channel is kept only
 *   for a Twitch origin, whatever the caller passed.
 */
export function setVoicePlaying(guildId: string, file: string, command: string, origin: PlayOrigin): void {
  const voice = getVoiceState(guildId);
  voice.playing = true;
  voice.currentFile = file;
  voice.lastCommand = command;
  voice.lastSource = origin.source;
  voice.lastPlayedAt = new Date();
  voice.lastFile = file;
  voice.lastUser = cleanDisplayText(origin.user);
  voice.lastChannel = origin.source === 'twitch' ? cleanDisplayText(origin.channel) : null;
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

/**
 * Returns a fresh, disconnected channel status record with no connection history yet.
 * @returns A new channel status that is disconnected and not live.
 */
function defaultChannelStatus(): ChannelStatus {
  return { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, isLive: false, liveCheckedAt: null };
}

/**
 * Updates a channel's connected flag within `map`, creating a default status
 * record on first use and stamping `lastConnectedAt`/`lastDisconnectedAt`
 * whenever the connected state actually transitions.
 *
 * @param map - The Twitch channel-status map to update.
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
 * Updates the connected state for a Twitch channel. No-ops (including no notification) if
 * `channel` doesn't normalize to a valid Twitch login (see {@link normalizeTwitchChannelName});
 * otherwise notifies the registered status-change listener (see {@link onStatusChanged}) with
 * `null`, since channel state isn't scoped to one guild.
 * @param channel - Twitch channel name, with or without a leading `#`; normalized before use.
 * @param connected - Whether the bot is now joined to the channel.
 */
export function setTwitchChannel(channel: string, connected: boolean): void {
  const key = normalizeTwitchChannelName(channel);
  if (key === null) return;
  updateChannel(state.twitch, key, connected);
  notifyStatusChanged(null);
}

/**
 * Updates the isLive flag for a Twitch channel. No-ops (including no notification) if `login`
 * doesn't normalize to a valid Twitch login (see {@link normalizeTwitchChannelName}) or the
 * channel isn't tracked yet; otherwise notifies the registered status-change listener (see
 * {@link onStatusChanged}) with `null`, since channel state isn't scoped to one guild.
 * @param login - Twitch login of the channel; normalized before use.
 * @param isLive - Whether the channel is currently live.
 */
export function setTwitchChannelLive(login: string, isLive: boolean): void {
  const key = normalizeTwitchChannelName(login);
  if (key === null) return;
  const existing = state.twitch.get(key);
  if (existing) {
    existing.isLive = isLive;
    notifyStatusChanged(null);
  }
}

/**
 * Records that the Twitch monitor just successfully checked these channels' live state, whether or not it changed. Tracked
 * channels only, like {@link setTwitchChannelLive}: a login that doesn't normalize, or isn't tracked yet, is skipped. Notifies the
 * registered status-change listener (see {@link onStatusChanged}) once with `null`, since channel state isn't scoped to one
 * guild, and only if at least one channel was updated. Called once per successful poll, not per channel.
 * @param logins - Twitch logins the poll covered; each is normalized before use.
 */
export function markTwitchChannelsLiveChecked(logins: Iterable<string>): void {
  const checkedAt = new Date();
  let updated = false;
  for (const login of logins) {
    const key = normalizeTwitchChannelName(login);
    const existing = key === null ? undefined : state.twitch.get(key);
    if (existing) {
      existing.liveCheckedAt = checkedAt;
      updated = true;
    }
  }
  if (updated) notifyStatusChanged(null);
}

/**
 * Returns a raw, unscoped snapshot of the current bot status (Discord ready/tag, voice for
 * the given guild, every tracked Twitch channel). Voice status
 * is the only field scoped here — to a single guild, so a viewer of one guild's dashboard
 * never sees another guild's now-playing info; a null guildId (no guild selected yet) reports
 * a default disconnected/idle voice status. The Discord server name and per-guild Twitch
 * channel filtering happen one layer up, in `src/web/guildScopedStatus.ts`, since that needs
 * DB lookups this in-memory store deliberately stays free of.
 *
 * @param guildId - Guild to read voice status for, or null if none is selected.
 * @returns Copies of the Discord status, the guild's voice status and every Twitch channel's status, keyed by login.
 */
export function getStatus(guildId: string | null) {
  return {
    discord: { ...state.discord },
    voice: { ...((guildId ? state.voice.get(guildId) : undefined) ?? defaultVoiceStatus()) },
    twitch: Object.fromEntries(state.twitch) as Record<string, ChannelStatus>,
  };
}
