// Companion-app API for the streamer's advanced commands: the list (so the app's mappings window
// can offer command names), and the acknowledgement the app sends after running a command's
// actions — a failure (or no acknowledgement in time) refunds the viewer.
import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { getAdvancedCommandUsageStreamerId, getStreamerByDiscordId, listAdvancedCommands } from '../../db';
import { acknowledgeAdvancedCommandUse } from '../../commands/advancedCommands/advancedCommandRefunds';
import { handleCompanionAck } from './companionAck';

const log = createLogger('CompanionCommands');
const router = Router();

/**
 * GET /api/companion/commands — bearer-token authenticated via `requireCompanionKey`. Lists the
 * authenticated streamer's advanced commands (empty when they aren't a streamer), so the
 * companion app knows which `advanced_command` events to expect.
 * @param req - Express request; `req.companionDiscordId` is set by `requireCompanionKey`.
 * @param res - `{ ok, commands: [{ id, name, trigger, pointCost, isEnabled, companionEnabled,
 *   parameters }] }`, or 500 on a DB error.
 */
router.get('/commands', requireCompanionKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const streamer = await getStreamerByDiscordId(req.companionDiscordId!);
    const commands = streamer ? await listAdvancedCommands(streamer.id) : [];
    res.json({
      ok: true,
      commands: commands.map((c) => ({
        id: c.id,
        name: c.name,
        trigger: c.triggerString,
        pointCost: c.pointCost,
        isEnabled: c.isEnabled,
        companionEnabled: c.companionEnabled,
        parameters: Object.fromEntries(c.params.map((p) => [p.key, p.value])),
      })),
    });
  } catch (err) {
    log.error('Failed to list advanced commands:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch commands' });
  }
});

/**
 * POST /api/companion/commands/ack — the companion app reports whether it ran an
 * `advanced_command` event's actions. Success marks the use succeeded; failure refunds the
 * viewer. The event must belong to the authenticated streamer.
 * @param req - Express request; JSON body `{ eventId, ok, error? }`.
 * @param res - `{ ok: true, resolved }` (`resolved` false when the use was already resolved, e.g.
 *   after the acknowledgement timeout), 400 for a malformed body, 404 for an unknown or
 *   another streamer's event, or 500 on an error.
 */
router.post('/commands/ack', requireCompanionKey, (req, res) => handleCompanionAck(req, res, {
  getOwnerStreamerId: getAdvancedCommandUsageStreamerId,
  acknowledge: acknowledgeAdvancedCommandUse,
  log,
  failureLabel: 'Failed to acknowledge advanced command:',
}));

export default router;
