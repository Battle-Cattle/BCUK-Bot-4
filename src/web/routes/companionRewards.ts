import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { getStreamerByDiscordId, getRedemptionAckStreamerId, listCompanionConfirmationRewardIds } from '../../db';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/twitchUserTokens';
import { acknowledgeRedemption, extendRedemptionAck } from '../../twitch/eventsub/twitchEventSubRedemptionAcks';
import { handleCompanionAck, handleCompanionProgress } from './companionAck';

const log = createLogger('CompanionRewards');
const router = Router();

/** A channel-point reward as surfaced to the companion app, so it knows what redemption events to expect. */
export interface CompanionKnownReward {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  backgroundColor: string;
  isEnabled: boolean;
  isUserInputRequired: boolean;
  /** Redemptions arrive with `ackRequired` and must be acknowledged, or the viewer is refunded. */
  companionConfirmationRequired: boolean;
}

/**
 * Maps a Twitch custom reward to the shape exposed to the companion app.
 * @param reward - The Twitch reward.
 * @param confirmationRewardIds - The streamer's rewards that require companion confirmation.
 * @returns The companion app's view of the reward.
 */
function toCompanionReward(reward: TwitchCustomReward, confirmationRewardIds: Set<string>): CompanionKnownReward {
  return {
    id: reward.id,
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    backgroundColor: reward.background_color,
    isEnabled: reward.is_enabled,
    isUserInputRequired: reward.is_user_input_required,
    companionConfirmationRequired: confirmationRewardIds.has(reward.id),
  };
}

/**
 * GET /api/companion/rewards — bearer-token authenticated via `requireCompanionKey`. Lists the
 * authenticated user's live Twitch custom channel-point rewards, so the companion app knows what
 * `channel_points_redemption` events to expect from `/api/companion/events`. Responds with an
 * empty list (not an error) when the user isn't a connected streamer or has no valid Twitch
 * token, like `fetchStreamerRewards` (`streamerRewards.ts`) — but unlike that helper it reports a
 * Twitch/token failure as a 500 rather than an empty list, so the app can tell "none" from "failed".
 */
router.get('/rewards', requireCompanionKey, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(req.companionDiscordId!);
    if (!streamer?.twitch_user_id) {
      res.json({ ok: true, rewards: [] });
      return;
    }
    const token = await getValidToken(streamer);
    if (!token) {
      res.json({ ok: true, rewards: [] });
      return;
    }
    const [rewards, confirmationRewardIds] = await Promise.all([
      getCustomRewards(streamer.twitch_user_id, token),
      listCompanionConfirmationRewardIds(streamer.id),
    ]);
    res.json({ ok: true, rewards: rewards.map((r) => toCompanionReward(r, confirmationRewardIds)) });
  } catch (err) {
    log.error('Failed to list rewards:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch rewards' });
  }
});

/**
 * POST /api/companion/rewards/ack — the companion app reports whether it ran the actions for a
 * `channel_points_redemption` event sent with `ackRequired`. Success fulfils the redemption on
 * Twitch; failure cancels it (refunding the viewer) and takes its increment back off the reward's
 * dynamic price. The redemption must belong to the authenticated streamer.
 * @param req - Express request; JSON body `{ eventId, ok, error? }`, where `eventId` is the event's `id`.
 * @param res - `{ ok: true, resolved }` (`resolved` false when the redemption was already resolved,
 *   e.g. after the acknowledgement timeout), 400 for a malformed body, 404 for an unknown or
 *   another streamer's redemption, or 500 on an error.
 */
router.post('/rewards/ack', requireCompanionKey, (req, res) => handleCompanionAck(req, res, {
  getOwnerStreamerId: getRedemptionAckStreamerId,
  acknowledge: acknowledgeRedemption,
  log,
  failureLabel: 'Failed to acknowledge redemption:',
}));

/**
 * POST /api/companion/rewards/progress — the companion app reports it's still running the actions
 * for a `channel_points_redemption` event sent with `ackRequired` (sent periodically before the
 * acknowledgement), restarting the acknowledgement timeout so long actions aren't refunded
 * mid-run. The redemption must belong to the authenticated streamer.
 * @param req - Express request; JSON body `{ eventId }`, where `eventId` is the event's `id`.
 * @param res - `{ ok: true, extended }` (`extended` false once the redemption is resolved or has been
 *   held as long as allowed), 400 for a malformed body, 404 for an unknown or another streamer's
 *   redemption, or 500 on an error.
 */
router.post('/rewards/progress', requireCompanionKey, (req, res) => handleCompanionProgress(req, res, {
  getOwnerStreamerId: getRedemptionAckStreamerId,
  extend: extendRedemptionAck,
  log,
  failureLabel: 'Failed to record redemption progress:',
}));

export default router;
