import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { requireCompanionKey } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';

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
}

/** Maps a Twitch custom reward to the shape exposed to the companion app. */
function toCompanionReward(reward: TwitchCustomReward): CompanionKnownReward {
  return {
    id: reward.id,
    title: reward.title,
    prompt: reward.prompt,
    cost: reward.cost,
    backgroundColor: reward.background_color,
    isEnabled: reward.is_enabled,
    isUserInputRequired: reward.is_user_input_required,
  };
}

/**
 * GET /api/companion/rewards — bearer-token authenticated via `requireCompanionKey`. Lists the
 * authenticated user's live Twitch custom channel-point rewards, so the companion app knows what
 * `channel_points_redemption` events to expect from `/api/companion/events`. Responds with an
 * empty list (not an error) when the user isn't a connected streamer or has no valid Twitch
 * token, matching `fetchTwitchRewards` in the Channel Points admin page.
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
    const rewards = await getCustomRewards(streamer.twitch_user_id, token);
    res.json({ ok: true, rewards: rewards.map(toCompanionReward) });
  } catch (err) {
    log.error('Failed to list rewards:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch rewards' });
  }
});

export default router;
