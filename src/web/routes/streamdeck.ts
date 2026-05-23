import { createLogger } from '../../logger';
import path from 'path';
import { Router } from 'express';
import { findTrigger, findSoundFiles, getAllSfxTriggers } from '../../db';
import { pickWeightedRandom } from '../../soundSelector';
import { playFile, VoiceNotConnectedError } from '../../sfxPlayer';
import { setVoicePlaying } from '../../statusStore';
import { SFX_FOLDER, DISCORD_GUILD_ID } from '../../config';
import { requireApiKey } from '../middleware';
import { getAvailableVoiceChannels } from '../../discordUtils';
import { connect, disconnect } from '../../audioPlayer';
import { getDiscordClient } from '../../discordBot';

const log = createLogger('Streamdeck');
const router = Router();

router.get('/sfx', requireApiKey, async (_req, res) => {
  try {
    const triggers = await getAllSfxTriggers();
    res.json({ ok: true, triggers });
  } catch (err) {
    log.error('Failed to list triggers:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch triggers' });
  }
});

router.post('/sfx', requireApiKey, async (req, res) => {
  const { command } = req.body as { command?: unknown };
  if (typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "command" field' });
    return;
  }

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
  const fullPath = path.join(SFX_FOLDER, filename);

  try {
    playFile(fullPath);
    setVoicePlaying(filename, normalizedCommand, 'streamdeck');
    log.info(`Playing '${filename.replace(/[\r\n]/g, '')}' for trigger '${normalizedCommand.replace(/[\r\n]/g, '')}'`);
    res.json({ ok: true, file: filename });
  } catch (err: unknown) {
    if (err instanceof VoiceNotConnectedError) {
      res.status(503).json({ ok: false, error: 'Bot is not connected to a voice channel' });
    } else {
      log.error(`Failed to play ${fullPath}:`, err);
      res.status(500).json({ ok: false, error: 'Failed to play sound' });
    }
  }
});

router.get('/voice/channels', requireApiKey, async (_req, res) => {
  try {
    const channels = await getAvailableVoiceChannels(DISCORD_GUILD_ID);
    res.json({ ok: true, channels });
  } catch (err) {
    log.error('Failed to list voice channels:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch voice channels' });
  }
});

router.post('/voice/join', requireApiKey, async (req, res) => {
  const { channelId } = req.body as { channelId?: unknown };
  if (typeof channelId !== 'string' || !channelId.trim()) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "channelId" field' });
    return;
  }

  const discordClient = getDiscordClient();
  if (!discordClient) {
    res.status(503).json({ ok: false, error: 'Discord client not ready' });
    return;
  }

  try {
    disconnect();
    await connect(discordClient, channelId.trim());
    res.json({ ok: true });
  } catch (err) {
    log.error('Voice join failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to join voice channel' });
  }
});

router.post('/voice/leave', requireApiKey, (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

export default router;
