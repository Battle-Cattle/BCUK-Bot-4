import path from 'path';
import { Router } from 'express';
import { findTrigger, findSoundFiles, getAllSfxTriggers } from '../../db';
import { pickWeightedRandom } from '../../soundSelector';
import { playFile, VoiceNotConnectedError } from '../../sfxPlayer';
import { setVoicePlaying } from '../../statusStore';
import { SFX_FOLDER } from '../../config';
import { requireApiKey } from '../middleware';

const router = Router();

router.get('/sfx', requireApiKey, async (_req, res) => {
  try {
    const triggers = await getAllSfxTriggers();
    res.json({ ok: true, triggers });
  } catch (err) {
    console.error('[Streamdeck] Failed to list triggers:', err);
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
    console.error('[Streamdeck] DB error looking up trigger:', err);
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
    console.error('[Streamdeck] DB error fetching sound files:', err);
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
    console.log(`[Streamdeck] Playing '${filename}' for trigger '${normalizedCommand}' (owner: ${req.apiKeyOwner})`);
    res.json({ ok: true, file: filename });
  } catch (err: unknown) {
    if (err instanceof VoiceNotConnectedError) {
      res.status(503).json({ ok: false, error: 'Bot is not connected to a voice channel' });
    } else {
      console.error(`[Streamdeck] Failed to play ${fullPath}:`, err);
      res.status(500).json({ ok: false, error: 'Failed to play sound' });
    }
  }
});

export default router;
