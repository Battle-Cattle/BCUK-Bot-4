import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import {
  getStreamerByDiscordId,
  getLoyaltyPointsLeaderboard,
  getLoyaltyPointsConfig,
  setLoyaltyPointsConfig,
  DEFAULT_POINTS_PER_MESSAGE,
  DEFAULT_POINTS_COOLDOWN_SECONDS,
  DEFAULT_POINTS_PER_SUB,
  DEFAULT_POINTS_PER_GIFT_SUB,
  type LoyaltyPointsConfig,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { requireStreamer, renderView, renderError } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { filterQueryParam } from './validation';

const log = createLogger('Web');
const router = Router();

/** Redirect target used when the requester isn't a streamer, scoped to the loyalty points page. */
const NOT_A_STREAMER_REDIRECT = '/loyalty-points?error=not_a_streamer';
const LEADERBOARD_SIZE = 50;

const KNOWN_ERRORS = new Set(['not_a_streamer', 'invalid_config', 'save_failed']);

/** Largest value a MySQL signed `INT` column (every `loyalty_points_config` column) can hold. */
const MAX_SIGNED_INT = 2_147_483_647;

/**
 * Parses a required non-negative integer form field (e.g. points_per_message), bounded to what
 * a signed `INT` column can hold (every `loyalty_points_config` column).
 * Rejects arrays (repeated fields), empty/whitespace input, non-integer input, negative values,
 * and values above {@link MAX_SIGNED_INT}.
 * @param value - The raw form field value.
 * @returns The parsed integer, or null if invalid.
 */
function parseNonNegativeIntField(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= MAX_SIGNED_INT ? n : null;
}

/**
 * Validates and normalizes the loyalty-points config form body.
 * @param body - The raw request body.
 * @returns The parsed config, or null if any field is missing/invalid.
 */
function parseConfigForm(body: Record<string, string | string[] | undefined>): LoyaltyPointsConfig | null {
  const pointsPerMessage = parseNonNegativeIntField(body.points_per_message);
  const cooldownSeconds = parseNonNegativeIntField(body.cooldown_seconds);
  const pointsPerSub = parseNonNegativeIntField(body.points_per_sub);
  const pointsPerGiftSub = parseNonNegativeIntField(body.points_per_gift_sub);
  if (pointsPerMessage === null || cooldownSeconds === null || pointsPerSub === null || pointsPerGiftSub === null) return null;
  return { pointsPerMessage, cooldownSeconds, pointsPerSub, pointsPerGiftSub };
}

/**
 * GET /loyalty-points — renders the loyalty points page: the signed-in streamer's leaderboard
 * and earn-rate configuration. Self-service only, like the Channel Points (reward pricing) admin
 * page — a viewer with no linked streamer record sees an empty "link your Twitch account" state
 * rather than being redirected away, so the page still renders for everyone signed in.
 */
router.get('/loyalty-points', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
    const [leaderboard, config] = streamer
      ? await Promise.all([getLoyaltyPointsLeaderboard(streamer.id, LEADERBOARD_SIZE), getLoyaltyPointsConfig(streamer.id)])
      : [[], null];

    renderView(res, 'loyaltyPoints', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      isStreamer: !!streamer,
      leaderboard,
      config: config ?? {
        pointsPerMessage: DEFAULT_POINTS_PER_MESSAGE,
        cooldownSeconds: DEFAULT_POINTS_COOLDOWN_SECONDS,
        pointsPerSub: DEFAULT_POINTS_PER_SUB,
        pointsPerGiftSub: DEFAULT_POINTS_PER_GIFT_SUB,
      },
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Loyalty points page error:', err);
    renderError(res, 500, 'Failed to load loyalty points page.', req.session.user);
  }
});

/**
 * POST /loyalty-points/config — saves the signed-in streamer's loyalty-points earn-rate
 * configuration. Self-service only, matching the Channel Points admin page's model: there's no
 * Mod+ override here, since a streamer's loyalty-points economy is theirs to tune.
 */
router.post('/loyalty-points/config', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const config = parseConfigForm(req.body);
    if (!config) return res.redirect('/loyalty-points?error=invalid_config');

    await setLoyaltyPointsConfig(streamer.id, config);
    res.redirect('/loyalty-points');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Loyalty points config save error:', err, basePath: '/loyalty-points', errorCode: 'save_failed' });
  }
});

export default router;
