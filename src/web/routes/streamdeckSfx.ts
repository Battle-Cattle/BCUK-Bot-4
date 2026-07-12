import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { findTrigger, findSoundFiles, getAllSfxTriggers, getApprovedGuildIdsForKey } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { playFile, VoiceNotConnectedError } from '../../audio/sfxPlayer';
import { setVoicePlaying } from '../../shared/statusStore';
import { requireApiKey } from '../middleware';
import { resolvePresenceGuildOrRespond, getReadyDiscordClientOrRespond } from './streamdeckGuildResolution';

const log = createLogger('Streamdeck');
const router = Router();

/**
 * Lists all SFX triggers available to play via Streamdeck. The SFX catalog
 * itself is global (not guild-scoped), so this only requires the key be
 * approved for at least one guild — matching the old `requireApiKey`
 * semantics before per-guild approval moved out of the identity lookup.
 */
router.get('/sfx', requireApiKey, async (req, res) => {
  try {
    const approvedGuildIds = await getApprovedGuildIdsForKey(req.apiKeyOwner!);
    if (approvedGuildIds.length === 0) {
      res.status(403).json({ ok: false, error: 'Key not approved for any guild' });
      return;
    }
    const triggers = await getAllSfxTriggers();
    res.json({ ok: true, triggers });
  } catch (err) {
    log.error('Failed to list triggers:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch triggers' });
  }
});

/**
 * Plays a random weighted sound file for the SFX trigger named in the request
 * body, in whichever guild the key owner is currently connected to voice in.
 */
router.post('/sfx', requireApiKey, async (req, res) => {
  const { command } = (req.body ?? {}) as { command?: unknown };
  if (typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "command" field' });
    return;
  }

  const discordClient = getReadyDiscordClientOrRespond(res);
  if (!discordClient) return;
  const guildId = await resolvePresenceGuildOrRespond(req, res, discordClient);
  if (!guildId) return;

  const normalizedCommand = command.trim().toLowerCase();

  let trigger;
  try {
    trigger = await findTrigger(normalizedCommand);
  } catch (err) {
    log.error('DB error looking up trigger:', err);
    res.status(500).json({ ok: false, error: 'Database error' });
    return;
  }
  if (!trigger) {
    res.status(404).json({ ok: false, error: 'Unknown command' });
    return;
  }

  let files;
  try {
    files = await findSoundFiles(trigger.id);
  } catch (err) {
    log.error('DB error fetching sound files:', err);
    res.status(500).json({ ok: false, error: 'Database error' });
    return;
  }
  if (files.length === 0) {
    res.status(404).json({ ok: false, error: 'No sound files for this command' });
    return;
  }

  const filename = pickWeightedRandom(files);

  try {
    playFile(filename, guildId);
    setVoicePlaying(guildId, filename, normalizedCommand, 'streamdeck');
    log.info(`Playing '${filename.replace(/[\r\n]/g, '')}' for trigger '${normalizedCommand.replace(/[\r\n]/g, '')}' in guild ${guildId}`);
    res.json({ ok: true, file: filename });
  } catch (err: unknown) {
    if (err instanceof VoiceNotConnectedError) {
      res.status(503).json({ ok: false, error: 'Bot is not connected to a voice channel' });
    } else {
      log.error(`Failed to play ${filename.replace(/[\r\n]/g, '')}:`, err);
      res.status(500).json({ ok: false, error: 'Failed to play sound' });
    }
  }
});

export default router;
