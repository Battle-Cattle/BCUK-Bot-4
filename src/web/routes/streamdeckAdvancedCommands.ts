// Stream Deck API for the key owner's own advanced commands: list them, fire one (free — no
// point cost, cooldowns, role, live-only or caps), and enable/disable one. The commands are the
// key owner's as a streamer, so every route resolves the key's Discord user to their streamer.
import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import { listAdvancedCommands, setAdvancedCommandEnabled } from '../../db';
import { requireApiKey } from '../middleware';
import { resolveStreamerOrRespond } from './streamdeckStreamerResolution';
import { triggerAdvancedCommandFromStreamDeck } from '../../commands/advancedCommands/advancedCommandHandler';

const log = createLogger('Streamdeck');
const router = Router();

/**
 * Reads a positive integer `commandId` from the JSON body.
 * @param req - The request.
 * @returns The id, or null if missing or invalid.
 */
function parseCommandId(req: Request): number | null {
  const { commandId } = (req.body ?? {}) as { commandId?: unknown };
  const id = typeof commandId === 'string' ? Number(commandId) : commandId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/streamdeck/advanced-commands — lists the key owner's advanced commands for the
 * plugin's dropdown and the toggle key's state.
 * @param req - Express request; authenticated by `requireApiKey`.
 * @param res - `{ ok, commands: [{ id, name, trigger, pointCost, isEnabled }] }`, 403 when the key
 *   isn't approved or its owner isn't a streamer, or 500 on a DB error.
 */
router.get('/advanced-commands', requireApiKey, async (req, res) => {
  try {
    const streamer = await resolveStreamerOrRespond(req, res);
    if (!streamer) return;
    const commands = (await listAdvancedCommands(streamer.id)).map((c) => ({
      id: c.id, name: c.name, trigger: c.triggerString, pointCost: c.pointCost, isEnabled: c.isEnabled,
    }));
    res.json({ ok: true, commands });
  } catch (err) {
    log.error('Failed to list advanced commands:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch commands' });
  }
});

/**
 * POST /api/streamdeck/advanced-commands/trigger — fires one of the key owner's advanced commands
 * for free.
 * @param req - Express request; JSON body `{ commandId }`.
 * @param res - `{ ok: true }`, 400 for a bad id, 403 as for the list route, 404
 *   `command_not_found`, 409 `command_disabled`, or 500 on an error.
 */
router.post('/advanced-commands/trigger', requireApiKey, async (req, res) => {
  const commandId = parseCommandId(req);
  if (commandId === null) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "commandId" field' });
    return;
  }
  try {
    const streamer = await resolveStreamerOrRespond(req, res);
    if (!streamer) return;
    const result = await triggerAdvancedCommandFromStreamDeck(
      { id: streamer.id, discordId: streamer.discord_id, twitchName: streamer.twitch_name },
      commandId,
    );
    if (result === 'ok') {
      res.json({ ok: true });
      return;
    }
    res.status(result === 'command_not_found' ? 404 : 409).json({ ok: false, error: result });
  } catch (err) {
    log.error('Failed to trigger advanced command from Stream Deck:', err);
    res.status(500).json({ ok: false, error: 'Failed to trigger command' });
  }
});

/**
 * POST /api/streamdeck/advanced-commands/enabled — enables or disables one of the key owner's
 * advanced commands, or toggles it when `enabled` is omitted.
 * @param req - Express request; JSON body `{ commandId, enabled? }`.
 * @param res - `{ ok: true, isEnabled }`, 400 for a bad id or `enabled`, 403 as for the list
 *   route, 404 `command_not_found`, or 500 on a DB error.
 */
router.post('/advanced-commands/enabled', requireApiKey, async (req, res) => {
  const commandId = parseCommandId(req);
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (commandId === null || (enabled !== undefined && typeof enabled !== 'boolean')) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "commandId"/"enabled" field' });
    return;
  }
  try {
    const streamer = await resolveStreamerOrRespond(req, res);
    if (!streamer) return;
    const isEnabled = await setAdvancedCommandEnabled(streamer.id, commandId, enabled);
    if (isEnabled === null) {
      res.status(404).json({ ok: false, error: 'command_not_found' });
      return;
    }
    res.json({ ok: true, isEnabled });
  } catch (err) {
    log.error('Failed to toggle advanced command from Stream Deck:', err);
    res.status(500).json({ ok: false, error: 'Failed to update command' });
  }
});

export default router;
