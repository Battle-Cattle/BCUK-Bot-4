import path from 'path';
import { createLogger } from './logger';
import { findTrigger, findSoundFiles } from './db';
import { pickWeightedRandom } from './soundSelector';
import { isPlaying } from './audioPlayer';
import { playFile, VoiceNotConnectedError } from './sfxPlayer';
import { SFX_FOLDER, GLOBAL_COOLDOWN_MS } from './config';
import { setVoicePlaying } from './statusStore';

const log = createLogger('CommandRouter');

let lastPlayedAt = 0;
let inFlight = false;

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
    // Look up trigger in DB
    const trigger = await findTrigger(command);
    if (!trigger) {
      // Not a recognised SFX command — silently ignore
      return;
    }

    // Find associated sound files
    const files = await findSoundFiles(trigger.id);
    if (files.length === 0) {
      log.warn(`[${source}] Trigger '${command}' has no sound files in DB`);
      return;
    }

    // Pick a file (weighted random)
    const filename = pickWeightedRandom(files);
    const fullPath = path.join(SFX_FOLDER, filename);

    log.info(`[${source}] Playing '${filename}' for trigger '${command}'`);

    try {
      playFile(fullPath);
      lastPlayedAt = Date.now();
      setVoicePlaying(filename, command, source);
    } catch (err) {
      if (err instanceof VoiceNotConnectedError) {
        log.info(`[${source}] Skipping '${command}' — not connected to voice channel`);
      } else {
        log.error(`[${source}] Failed to play ${fullPath}:`, err);
      }
    }
  } finally {
    inFlight = false;
  }
}
