import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { findCachedSfxTrigger, getAllSfxTriggers, getApprovedGuildIdsForKey } from '../../db';
import { pickWeightedRandom } from '../../audio/soundSelector';
import { playFile, VoiceNotConnectedError } from '../../audio/sfxPlayer';
import { setVoicePlaying } from '../../shared/statusStore';
import { requireApiKey } from '../middleware';
import { resolvePresenceGuildOrRespond, getReadyDiscordClientOrRespond } from './streamdeckGuildResolution';

const log = createLogger('Streamdeck');
const router = Router();

/**
 * A Play SFX request that takes longer than this to handle (auth, guild resolution, trigger
 * lookup and handing the sound to the player) is logged as a warning, so a slow bot-side
 * response is told apart from a slow audio start (logged by the audio player itself).
 */
const SLOW_SFX_REQUEST_MS = 250;

/**
 * Stamps the request's arrival time in `res.locals.sfxStartedAt`, ahead of `requireApiKey`, so
 * the Play SFX log line can include the key lookup's time too.
 * @param _req - Express request (unused).
 * @param res - Express response; its locals get the timestamp.
 * @param next - Continues to the next middleware.
 */
function stampRequestStart(_req: Request, res: Response, next: NextFunction): void {
  res.locals.sfxStartedAt = performance.now();
  next();
}

/**
 * Milliseconds since {@link stampRequestStart} ran for this response, rounded.
 * @param res - Express response whose locals hold the start time.
 * @returns Elapsed whole milliseconds, or 0 if the request was never stamped.
 */
function elapsedMs(res: Response): number {
  const startedAt = res.locals.sfxStartedAt as number | undefined;
  return startedAt === undefined ? 0 : Math.round(performance.now() - startedAt);
}

/**
 * Lists all SFX triggers available to play via Streamdeck, hidden ones included (hidden only
 * keeps a trigger off the public list; it still plays). The SFX catalog itself is global (not
 * guild-scoped), so this only requires the key be approved for at least one guild — matching
 * the old `requireApiKey` semantics before per-guild approval moved out of the identity lookup.
 * Each trigger carries only what the plugin's dropdown uses, not its sound files, weights or
 * IDs, which would otherwise be sent on every refresh for nothing.
 */
router.get('/sfx', requireApiKey, async (req, res) => {
  try {
    const approvedGuildIds = await getApprovedGuildIdsForKey(req.apiKeyOwner!);
    if (approvedGuildIds.length === 0) {
      res.status(403).json({ ok: false, error: 'Key not approved for any guild' });
      return;
    }
    const triggers = (await getAllSfxTriggers()).map(({ triggerCommand, categoryName, description }) => ({
      triggerCommand,
      categoryName,
      description,
    }));
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
router.post('/sfx', stampRequestStart, requireApiKey, async (req, res) => {
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

  let lookup;
  try {
    lookup = await findCachedSfxTrigger(normalizedCommand);
  } catch (err) {
    log.error('DB error looking up trigger:', err);
    res.status(500).json({ ok: false, error: 'Database error' });
    return;
  }
  if (!lookup) {
    res.status(404).json({ ok: false, error: 'Unknown command' });
    return;
  }
  const { files } = lookup;
  if (files.length === 0) {
    res.status(404).json({ ok: false, error: 'No sound files for this command' });
    return;
  }

  const filename = pickWeightedRandom(files);

  try {
    await playFile(filename, guildId);
    setVoicePlaying(guildId, filename, normalizedCommand, 'streamdeck');
    const handledMs = elapsedMs(res);
    const message = `Playing '${filename.replace(/[\r\n]/g, '')}' for trigger '${normalizedCommand.replace(/[\r\n]/g, '')}' in guild ${guildId} (request handled in ${handledMs}ms)`;
    if (handledMs > SLOW_SFX_REQUEST_MS) log.warn(message);
    else log.info(message);
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
