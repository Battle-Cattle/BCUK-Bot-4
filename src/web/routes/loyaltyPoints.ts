import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import {
  findUser,
  getStreamerByDiscordId,
  getLoyaltyPointsLeaderboard,
  getLoyaltyPointsConfig,
  setLoyaltyPointsConfig,
  getLoyaltyPointsExclusions,
  addLoyaltyPointsExclusion,
  removeLoyaltyPointsExclusion,
  type LoyaltyPointsConfig,
} from '../../db';
import { DEFAULT_LOYALTY_POINTS_CONFIG } from '../../shared/loyaltyPointsDefaults';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getSessionUser } from '../session';
import { requireStreamer, renderView, renderError } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { filterQueryParam, MAX_INT_COLUMN_VALUE, parseIntField } from './validation';

const log = createLogger('Web');
const router = Router();

/** Redirect target used when the requester isn't a streamer, scoped to the loyalty points page. */
const NOT_A_STREAMER_REDIRECT = '/loyalty-points?error=not_a_streamer';
const LEADERBOARD_SIZE = 50;

const KNOWN_ERRORS = new Set(['not_a_streamer', 'invalid_config', 'save_failed', 'missing_prerequisites', 'invalid_username', 'exclusion_failed']);

/** A Twitch login as the `loyalty_points_exclusion.twitch_username` column can hold it. */
const TWITCH_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Loyalty Points is opt-in, and every prerequisite must hold before a streamer is allowed to
 * enable it: a linked Twitch account and the chat bot enabled (both needed for the bot to ever
 * be present in their chat), plus already being a monitored streamer (needed for `streamerId` to
 * resolve at all in `twitchBot.ts`). Each flag here maps 1:1 to one of those checks.
 */
interface LoyaltyPointsPrerequisites {
  twitchLinked: boolean;
  chatBotEnabled: boolean;
  isMonitoredStreamer: boolean;
}

/**
 * Computes the opt-in prerequisites from already-fetched user/streamer records, so callers reuse
 * lookups they've already made rather than querying twice.
 * @param user - The signed-in user's row, or null if somehow missing.
 * @param isMonitoredStreamer - Whether the signed-in user already has a `streamer` row.
 * @returns The prerequisite statuses and whether all of them are currently met.
 */
function computePrerequisites(
  user: { twitch_name: string | null; is_twitch_bot_enabled: boolean } | null,
  isMonitoredStreamer: boolean,
): { prerequisites: LoyaltyPointsPrerequisites; allMet: boolean } {
  const prerequisites: LoyaltyPointsPrerequisites = {
    twitchLinked: !!user?.twitch_name,
    chatBotEnabled: !!user?.is_twitch_bot_enabled,
    isMonitoredStreamer,
  };
  return { prerequisites, allMet: Object.values(prerequisites).every(Boolean) };
}

/**
 * Parses the `twitch_username` field posted by the "Exclude bot" / "Remove exclusion" buttons.
 * Rejects arrays (repeated fields) and anything that isn't a plausible Twitch login.
 * @param value - The raw form field value.
 * @returns The trimmed login, or null if invalid.
 */
function parseTwitchUsernameField(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return TWITCH_USERNAME_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Validates and normalizes the loyalty-points config form body. `enabled` comes from a checkbox,
 * which browsers omit entirely from the submitted body when unchecked — so its absence (rather
 * than an empty/invalid value) means false, not a validation failure.
 * @param body - The raw request body.
 * @returns The parsed config, or null if any rate field is missing/invalid.
 */
function parseConfigForm(body: Record<string, string | string[] | undefined>): LoyaltyPointsConfig | null {
  const pointsPerMessage = parseIntField(body.points_per_message, 0, MAX_INT_COLUMN_VALUE);
  const cooldownSeconds = parseIntField(body.cooldown_seconds, 0, MAX_INT_COLUMN_VALUE);
  const pointsPerSub = parseIntField(body.points_per_sub, 0, MAX_INT_COLUMN_VALUE);
  const pointsPerGiftSub = parseIntField(body.points_per_gift_sub, 0, MAX_INT_COLUMN_VALUE);
  if (pointsPerMessage === null || cooldownSeconds === null || pointsPerSub === null || pointsPerGiftSub === null) return null;
  return { enabled: body.enabled === '1', pointsPerMessage, cooldownSeconds, pointsPerSub, pointsPerGiftSub };
}

/**
 * GET /loyalty-points — renders the loyalty points page: the signed-in streamer's opt-in status,
 * prerequisite checklist, leaderboard, excluded bots, and earn-rate configuration. Self-service only, like the
 * Channel Points (reward pricing) admin page — a viewer with no linked streamer record sees an
 * empty "link your Twitch account" state rather than being redirected away, so the page still
 * renders for everyone signed in.
 */
router.get('/loyalty-points', requireAuth, csrfProtection, async (req, res) => {
  try {
    const discordId = getSessionUser(req).discordId;
    const [user, streamer] = await Promise.all([findUser(discordId), getStreamerByDiscordId(discordId)]);
    const [leaderboard, config, excludedUsers] = streamer
      ? await Promise.all([
        getLoyaltyPointsLeaderboard(streamer.id, LEADERBOARD_SIZE),
        getLoyaltyPointsConfig(streamer.id),
        getLoyaltyPointsExclusions(streamer.id),
      ])
      : [[], null, []];
    const { prerequisites, allMet } = computePrerequisites(user, !!streamer);

    renderView(res, 'loyaltyPoints', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      isStreamer: !!streamer,
      prerequisites,
      allPrerequisitesMet: allMet,
      leaderboard,
      excludedUsers,
      config: config ?? DEFAULT_LOYALTY_POINTS_CONFIG,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Loyalty points page error:', err);
    renderError(res, 500, 'Failed to load loyalty points page.', req.session.user);
  }
});

/**
 * POST /loyalty-points/config — saves the signed-in streamer's loyalty-points configuration,
 * including the opt-in switch. Self-service only, matching the Channel Points admin page's model:
 * there's no Mod+ override here, since a streamer's loyalty-points economy is theirs to tune.
 * Turning the feature off is always allowed; turning it on is rejected (with a clear error,
 * rather than silently persisting a no-op `enabled: true`) unless every prerequisite — a linked
 * Twitch account, the chat bot enabled, and already being a monitored streamer — currently holds.
 */
router.post('/loyalty-points/config', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
    if (!streamer) return;

    const config = parseConfigForm(req.body);
    if (!config) return res.redirect('/loyalty-points?error=invalid_config');

    if (config.enabled) {
      const user = await findUser(getSessionUser(req).discordId);
      const { allMet } = computePrerequisites(user, true);
      if (!allMet) return res.redirect('/loyalty-points?error=missing_prerequisites');
    }

    await setLoyaltyPointsConfig(streamer.id, config);
    res.redirect('/loyalty-points');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Loyalty points config save error:', err, basePath: '/loyalty-points', errorCode: 'save_failed' });
  }
});

/** A cache-invalidating write that adds an account to, or removes it from, a streamer's exclusion list. */
type ExclusionWrite = (streamerId: number, twitchUsername: string) => Promise<void>;

/**
 * Builds the handler shared by the "Exclude bot" and "Remove exclusion" forms: resolves the
 * signed-in streamer, validates the posted login, applies `write`, and redirects back to the page.
 * Self-service only, like the config form — a streamer manages exclusions on their own channel.
 * @param write - The cache-invalidating DB write to apply.
 * @param logLabel - Label to log a failed write under.
 * @returns The Express route handler.
 */
function exclusionHandler(write: ExclusionWrite, logLabel: string) {
  return async (req: Request, res: Response) => {
    try {
      const streamer = await requireStreamer(req, res, NOT_A_STREAMER_REDIRECT);
      if (!streamer) return;

      const twitchUsername = parseTwitchUsernameField((req.body as Record<string, string | string[] | undefined>).twitch_username);
      if (!twitchUsername) return res.redirect('/loyalty-points?error=invalid_username');

      await write(streamer.id, twitchUsername);
      res.redirect('/loyalty-points');
    } catch (err) {
      logAndRedirectError({ res, log, logLabel, err, basePath: '/loyalty-points', errorCode: 'exclusion_failed' });
    }
  };
}

/**
 * POST /loyalty-points/exclusions — the leaderboard's "Exclude bot" button: stops the posted
 * account earning points on the signed-in streamer's channel and hides it from the leaderboard.
 */
router.post('/loyalty-points/exclusions', requireAuth, csrfProtection, exclusionHandler(addLoyaltyPointsExclusion, 'Loyalty points exclude error:'));

/**
 * POST /loyalty-points/exclusions/remove — un-excludes the posted account, so it earns points
 * and appears on the leaderboard again (with whatever balance it had before being excluded).
 */
router.post('/loyalty-points/exclusions/remove', requireAuth, csrfProtection, exclusionHandler(removeLoyaltyPointsExclusion, 'Loyalty points un-exclude error:'));

export default router;
