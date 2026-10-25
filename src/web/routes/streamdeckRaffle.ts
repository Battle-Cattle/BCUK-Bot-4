// Stream Deck API for starting a loyalty-points raffle in the key owner's own Twitch chat, the
// same raffle the broadcaster starts with `!raffle <amount>`.
import { createLogger } from '../../shared/logger';
import { Router, type Request } from 'express';
import { requireApiKey } from '../middleware';
import { parseRaffleAmount, startRaffle, type StartRaffleResult } from '../../commands/raffle/raffleHandler';
import { resolveStreamerOrRespond } from './streamdeckStreamerResolution';

const log = createLogger('Streamdeck');
const router = Router();

/** HTTP status and error code for each {@link startRaffle} failure. */
const RAFFLE_ERRORS: Record<Exclude<StartRaffleResult, 'ok'>, { status: number; error: string }> = {
  already_running: { status: 409, error: 'raffle_already_running' },
  points_disabled: { status: 409, error: 'points_disabled' },
  chat_unavailable: { status: 503, error: 'chat_unavailable' },
};

/**
 * Reads the raffle prize from the JSON body: a number, or a string such as `100`, `1,000` or `1K`.
 * @param req - The request.
 * @returns The prize, or null if missing or invalid.
 */
function parseAmount(req: Request): number | null {
  const { amount } = (req.body ?? {}) as { amount?: unknown };
  if (typeof amount === 'number') return parseRaffleAmount(String(amount));
  return typeof amount === 'string' ? parseRaffleAmount(amount) : null;
}

/**
 * POST /api/streamdeck/raffle — starts a 60-second loyalty-points raffle in the key owner's chat.
 * @param req - Express request; JSON body `{ amount }`.
 * @param res - `{ ok: true, amount }`, 400 `invalid_amount`, 403 when the key isn't approved or its
 *   owner isn't a streamer, 409 `raffle_already_running` / `points_disabled`, 503
 *   `chat_unavailable` when the bot can't post in the chat, or 500 on an error.
 */
router.post('/raffle', requireApiKey, async (req, res) => {
  const amount = parseAmount(req);
  if (amount === null) {
    res.status(400).json({ ok: false, error: 'invalid_amount' });
    return;
  }
  try {
    const streamer = await resolveStreamerOrRespond(req, res);
    if (!streamer) return;
    const result = await startRaffle(streamer.twitch_name, streamer.id, amount);
    if (result === 'ok') {
      res.json({ ok: true, amount });
      return;
    }
    const { status, error } = RAFFLE_ERRORS[result];
    res.status(status).json({ ok: false, error });
  } catch (err) {
    log.error('Failed to start raffle from Stream Deck:', err);
    res.status(500).json({ ok: false, error: 'Failed to start raffle' });
  }
});

export default router;
