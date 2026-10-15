// Companion-app API for the streamer's advanced commands: the list (so the app's mappings window
// can offer command names), and the acknowledgement the app sends after running a command's
// actions — a failure (or no acknowledgement in time) refunds the viewer.
import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { getAdvancedCommandUsageStreamerId, getStreamerByDiscordId, listAdvancedCommands } from '../../db';
import { acknowledgeAdvancedCommandUse } from '../../commands/advancedCommands/advancedCommandRefunds';

const log = createLogger('CompanionCommands');
const router = Router();

const EVENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_ACK_ERROR_LENGTH = 255;

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
 * Validates an acknowledgement body.
 * @param body - The parsed JSON body.
 * @returns The event id, outcome and error text, or null if malformed.
 */
function parseAck(body: unknown): { eventId: string; ok: boolean; error: string | null } | null {
  const { eventId, ok, error } = (body ?? {}) as { eventId?: unknown; ok?: unknown; error?: unknown };
  if (typeof eventId !== 'string' || !EVENT_ID_PATTERN.test(eventId) || typeof ok !== 'boolean') return null;
  if (error != null && typeof error !== 'string') return null;
  return { eventId, ok, error: typeof error === 'string' ? error.slice(0, MAX_ACK_ERROR_LENGTH) : null };
}

/**
 * POST /api/companion/commands/ack — the companion app reports whether it ran an
 * `advanced_command` event's actions. Success marks the use succeeded; failure refunds the
 * viewer. The event must belong to the authenticated streamer.
 * @param req - Express request; JSON body `{ eventId, ok, error? }`.
 * @param res - `{ ok: true, resolved }` (`resolved` false when the use was already resolved, e.g.
 *   after the acknowledgement timeout), 400 for a malformed body, 404 for an unknown or
 *   another streamer's event, or 500 on an error.
 */
router.post('/commands/ack', requireCompanionKey, async (req, res) => {
  const ack = parseAck(req.body);
  if (!ack) {
    res.status(400).json({ ok: false, error: 'Expected { eventId, ok, error? }' });
    return;
  }
  try {
    const [streamer, ownerId] = await Promise.all([
      getStreamerByDiscordId(req.companionDiscordId!),
      getAdvancedCommandUsageStreamerId(ack.eventId),
    ]);
    if (ownerId === null || ownerId !== streamer?.id) {
      res.status(404).json({ ok: false, error: 'event_not_found' });
      return;
    }
    const resolved = await acknowledgeAdvancedCommandUse(ack.eventId, { ok: ack.ok, error: ack.error });
    res.json({ ok: true, resolved });
  } catch (err) {
    log.error('Failed to acknowledge advanced command:', err);
    res.status(500).json({ ok: false, error: 'Failed to acknowledge' });
  }
});

export default router;
