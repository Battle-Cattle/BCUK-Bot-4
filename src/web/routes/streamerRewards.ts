import type { Logger } from 'winston';
import type { DbStreamerEventSub } from '../../db';
import { getCustomRewards, type TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';

/**
 * Fetches a streamer's live Twitch custom channel-point rewards for an admin page's reward
 * picker. Any failure — no linked Twitch account, no valid token, a token refresh error, or a
 * Helix error — is logged and yields an empty list, so the page still renders.
 * Shared by the Channel Points and Overlay admin pages.
 * @param streamer - The streamer whose rewards to list.
 * @param log - Logger for the warning on failure.
 * @returns The streamer's rewards, or an empty list.
 */
export async function fetchStreamerRewards(streamer: DbStreamerEventSub, log: Logger): Promise<TwitchCustomReward[]> {
  if (!streamer.twitch_user_id) return [];
  try {
    const token = await getValidToken(streamer);
    if (!token) return [];
    return await getCustomRewards(streamer.twitch_user_id, token);
  } catch (err) {
    log.warn('Failed to fetch Twitch custom rewards:', err);
    return [];
  }
}
