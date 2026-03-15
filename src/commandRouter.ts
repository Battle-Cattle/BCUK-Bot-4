import path from 'path';
import { findTrigger, findSoundFiles } from './db';
import { pickWeightedRandom } from './soundSelector';
import { isPlaying, playFile } from './audioPlayer';
import { SFX_FOLDER, GLOBAL_COOLDOWN_MS } from './config';
import { setVoicePlaying } from './statusStore';

let lastPlayedAt = 0;

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
    console.log(`[${source}] Cooldown active, ignoring '${command}'`);
    return;
  }

  // Ignore if already playing
  if (isPlaying()) {
    console.log(`[${source}] Already playing, ignoring '${command}'`);
    return;
  }

  // Look up trigger in DB
  const trigger = await findTrigger(command);
  if (!trigger) {
    // Not a recognised SFX command — silently ignore
    return;
  }

  // Find associated sound files
  const files = await findSoundFiles(trigger.id);
  if (files.length === 0) {
    console.warn(`[${source}] Trigger '${command}' has no sound files in DB`);
    return;
  }

  // Pick a file (weighted random)
  const filename = pickWeightedRandom(files);
  const fullPath = path.join(SFX_FOLDER, filename);

  console.log(`[${source}] Playing '${filename}' for trigger '${command}'`);

  try {
    playFile(fullPath);
    lastPlayedAt = Date.now();
    setVoicePlaying(filename, command, source);
  } catch (err) {
    console.error(`[${source}] Failed to play ${fullPath}:`, err);
  }
}
