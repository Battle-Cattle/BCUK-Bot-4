import path from 'path';
import { createLogger } from '../shared/logger';
import { findCachedSfxTrigger } from '../db';
import { pickWeightedRandom } from './soundSelector';
import { isPlaying } from '../audio/audioPlayer';
import { playFile, VoiceNotConnectedError } from '../audio/sfxPlayer';
import { SFX_FOLDER, GLOBAL_COOLDOWN_MS } from '../shared/config';
import { setVoicePlaying } from '../shared/statusStore';
import { safeResolve } from '../shared/pathUtils';
import { recordCommandTestEntry } from './commandMonitorStore';
import { getOrCreate } from '../shared/mapUtils';

const log = createLogger('CommandRouter');

interface GuildCommandState {
  lastPlayedAt: number;
  inFlight: boolean;
}

const guildStates = new Map<string, GuildCommandState>();

/** Returns the cooldown/in-flight state for a guild, creating a fresh record on first use. */
function getGuildCommandState(guildId: string): GuildCommandState {
  return getOrCreate(guildStates, guildId, () => ({ lastPlayedAt: 0, inFlight: false }));
}

/**
 * Forgets a guild's cooldown/in-flight state so it stops occupying memory
 * once the bot is no longer in that guild. Safe to call for a guild with no
 * state (no-op). Called from the `guildDelete` handler; a guild the bot
 * rejoins later starts fresh via {@link getGuildCommandState}'s lazy creation.
 *
 * @param guildId - Guild to forget.
 */
export function forgetGuildCommandState(guildId: string): void {
  guildStates.delete(guildId);
}

/**
 * Looks up a trigger command's sound files, picks one, and plays it into the
 * given guild, recording the play time on that guild's cooldown state and a
 * command-monitor entry on success.
 *
 * @param command - Lowercased trigger command to look up.
 * @param source - Where the command came from, used for logging/status.
 * @param guildId - Guild to play the sound into.
 * @param state - The guild's cooldown/in-flight state; `lastPlayedAt` is updated on success.
 */
async function lookupAndPlay(
  command: string,
  source: 'twitch' | 'discord' | 'tiktok',
  guildId: string,
  state: GuildCommandState,
): Promise<void> {
  const lookup = await findCachedSfxTrigger(command);
  if (!lookup) return;
  const { files } = lookup;
  if (files.length === 0) {
    log.warn(`[${source}] Trigger '${command}' has no sound files in DB`);
    return;
  }

  const filename = pickWeightedRandom(files);
  const fullPath = safeResolve(SFX_FOLDER, filename);
  if (!fullPath) {
    log.error(`[${source}] Invalid file path for trigger '${command}'`);
    return;
  }

  log.info(`[${source}] Playing '${filename}' for trigger '${command}' in guild ${guildId}`);

  try {
    await playFile(fullPath, guildId);
    state.lastPlayedAt = Date.now();
    setVoicePlaying(guildId, filename, command, source);
    recordCommandTestEntry({ source, command, response: filename, channel: null, user: null });
  } catch (err) {
    if (err instanceof VoiceNotConnectedError) {
      log.info(`[${source}] Skipping '${command}' — not connected to voice channel`);
    } else {
      log.error(`[${source}] Failed to play ${fullPath}:`, err);
    }
  }
}

/**
 * Handle a raw chat message from Twitch, Discord, or TikTok.
 * Performs all checks (prefix, cooldown, playing state, DB lookup) before playing.
 * Cooldown and in-flight state are tracked per guild so a trigger in one guild
 * never blocks or cools down a trigger in another.
 *
 * @param rawMessage The full message string as received from chat.
 * @param source     Label used for console logging ('twitch' | 'discord' | 'tiktok').
 * @param guildId    The guild to target; null when no active guild could be
 *   resolved (e.g. a Twitch/TikTok command fired while the streamer isn't
 *   connected to voice anywhere) — the command is skipped with a warning.
 */
export async function handleCommand(
  rawMessage: string,
  source: 'twitch' | 'discord' | 'tiktok',
  guildId: string | null,
): Promise<void> {
  const trimmed = rawMessage.trim();

  // Extract the first word of the message — this is matched directly against
  // trigger_command in the DB, which already includes whatever prefix is used
  const command = trimmed.split(/\s+/)[0].toLowerCase();
  if (!command) return;

  if (guildId === null) {
    log.warn(`[${source}] No active guild resolved for command '${command}', skipping`);
    return;
  }

  const state = getGuildCommandState(guildId);

  // Per-guild cooldown check
  const now = Date.now();
  if (now - state.lastPlayedAt < GLOBAL_COOLDOWN_MS) {
    log.info(`[${source}] Cooldown active for guild ${guildId}, ignoring '${command}'`);
    return;
  }

  // Ignore if this guild is already playing or another handler is mid-lookup
  if (isPlaying(guildId) || state.inFlight) {
    log.info(`[${source}] Already playing in guild ${guildId}, ignoring '${command}'`);
    return;
  }

  // Claim the slot before any await so concurrent message handlers see the flag.
  state.inFlight = true;
  try {
    await lookupAndPlay(command, source, guildId, state);
  } finally {
    state.inFlight = false;
  }
}
