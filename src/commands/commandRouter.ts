import path from 'path';
import { createLogger } from '../shared/logger';
import { findTrigger, findSoundFiles } from '../db';
import { pickWeightedRandom } from './soundSelector';
import { isPlaying } from '../audio/audioPlayer';
import { playFile, VoiceNotConnectedError } from '../audio/sfxPlayer';
import { SFX_FOLDER, GLOBAL_COOLDOWN_MS } from '../shared/config';
import { setVoicePlaying } from '../shared/statusStore';
import { safeResolve } from '../shared/pathUtils';
import { recordCommandTestEntry } from './commandMonitorStore';

const log = createLogger('CommandRouter');

let lastPlayedAt = 0;
let inFlight = false;

async function lookupAndPlay(command: string, source: 'twitch' | 'discord' | 'tiktok'): Promise<void> {
  const trigger = await findTrigger(command);
  if (!trigger) return;

  const files = await findSoundFiles(trigger.id);
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

  log.info(`[${source}] Playing '${filename}' for trigger '${command}'`);

  try {
    playFile(fullPath);
    lastPlayedAt = Date.now();
    setVoicePlaying(filename, command, source);
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
 * Handle a raw chat message from either Twitch or Discord.
 * Performs all checks (prefix, cooldown, playing state, DB lookup) before playing.
 *
 * @param rawMessage The full message string as received from chat.
 * @param source     Label used for console logging ('twitch' | 'discord').
 */
export async function handleCommand(rawMessage: string, source: 'twitch' | 'discord' | 'tiktok'): Promise<void> {
  const trimmed = rawMessage.trim();

  // Extract the first word of the message — this is matched directly against
  // trigger_command in the DB, which already includes whatever prefix is used
  const command = trimmed.split(/\s+/)[0].toLowerCase();
  if (!command) return;

  // Global cooldown check
  const now = Date.now();
  if (now - lastPlayedAt < GLOBAL_COOLDOWN_MS) {
    log.info(`[${source}] Cooldown active, ignoring '${command}'`);
    return;
  }

  // Ignore if already playing or another handler is mid-lookup
  if (isPlaying() || inFlight) {
    log.info(`[${source}] Already playing, ignoring '${command}'`);
    return;
  }

  // Claim the slot before any await so concurrent message handlers see the flag.
  inFlight = true;
  try {
    await lookupAndPlay(command, source);
  } finally {
    inFlight = false;
  }
}
