import { createLogger } from '../../shared/logger';
import { getDiscordClient } from '../../discord/discordBot';

const log = createLogger('TwitchMonitor');
import { getTextChannel, tryDeleteDiscordMessage, tryEditDiscordMessage } from '../../discord/discordUtils';
import { setStreamerLive, clearStreamerLive, DbStreamerFull } from '../../db';
import { getStreams, TwitchStream } from '../twitchApi';
import { LiveState, makeLiveState } from './twitchMonitorTypes';
import { buildEmbed, templateVars } from './twitchMonitorEmbed';
import { updateMultitwitch } from './twitchMonitorMultitwitch';
import { postAnnouncement } from './twitchMonitorAnnouncements';
import { fillTemplate } from '../../shared/textTemplate';

/**
 * Tries to edit the streamer's existing startup-time "now live" message in place
 * (used when the bot restarts while a streamer is already live and previously
 * posted). Returns false — without throwing — if the client isn't ready, the
 * streamer has no recorded message/channel, the channel isn't text-based, or the
 * edit fails with a Discord not-found error (message/channel deleted while the
 * bot was down); the caller falls back to {@link postAnnouncement} in that case.
 * Any other error is logged (once here, and again inside
 * {@link tryEditDiscordMessage} for the underlying Discord failure) and rethrown.
 */
export async function tryEditStartupMessage(
  liveStates: Map<string, LiveState>,
  streamer: DbStreamerFull,
  liveStream: TwitchStream,
): Promise<boolean> {
  const discordClient = getDiscordClient();
  if (!discordClient) return false;
  if (!streamer.discord_channel_id || !streamer.discord_message_id) return false;
  try {
    const channel = await getTextChannel(discordClient, streamer.discord_channel_id);
    if (!channel) return false;
    const vars = templateVars(liveStream.user_login, liveStream);
    const content = fillTemplate(streamer.group.live_message, vars, 'keep');
    const embed = buildEmbed(liveStream);
    const edited = await tryEditDiscordMessage(discordClient, streamer.discord_channel_id, streamer.discord_message_id, { content, embeds: [embed] });
    if (!edited) return false;
    liveStates.set(String(streamer.id), makeLiveState(streamer, liveStream, streamer.discord_message_id, streamer.discord_channel_id));
    await setStreamerLive(streamer.id, streamer.discord_message_id, streamer.discord_channel_id, liveStream.game_name);
    return true;
  } catch (err) {
    log.error(`Failed to edit startup message for ${streamer.twitch_name ?? 'unknown'}:`, err);
    throw err;
  }
}

/**
 * Handles a streamer found to already be live at bot startup: if a previous
 * announcement message is recorded, tries to edit it in place via
 * {@link tryEditStartupMessage}; otherwise (or if the edit isn't possible)
 * falls back to posting a fresh announcement via {@link postAnnouncement}.
 * @param liveStates - Map of live streamer states, keyed by streamer DB row id.
 * @param streamer - Full streamer record (including its stream group) from the database.
 * @param liveStream - The current live Twitch stream data.
 * @param groupsWithChanges - Accumulator of stream group IDs whose MultiTwitch state needs refreshing.
 * @returns Resolves once the streamer's announcement has been reconciled.
 */
export async function handleLiveStreamerOnStartup(
  liveStates: Map<string, LiveState>,
  streamer: DbStreamerFull,
  liveStream: TwitchStream,
  groupsWithChanges: Set<number>,
): Promise<void> {
  if (streamer.discord_message_id && streamer.discord_channel_id) {
    if (!getDiscordClient()) {
      liveStates.set(String(streamer.id), makeLiveState(streamer, liveStream, streamer.discord_message_id, streamer.discord_channel_id));
      return;
    }
    try {
      if (await tryEditStartupMessage(liveStates, streamer, liveStream)) {
        groupsWithChanges.add(streamer.group.id);
        return;
      }
    } catch {
      // Edit failed (already logged) — skip postAnnouncement for this streamer
      return;
    }
  }
  await postAnnouncement(liveStates, streamer, liveStream);
}

/**
 * Handles a streamer found to be offline at bot startup despite having a
 * recorded live announcement: deletes the stale Discord message (best-effort)
 * and clears the streamer's live state in the DB. `liveStates` is empty at
 * startup, so {@link deleteAnnouncement}'s in-memory-map path can't be reused —
 * the cleanup is done directly here instead.
 * @param streamer - Full streamer record (including its stream group) from the database.
 * @param groupsWithChanges - Accumulator of stream group IDs whose MultiTwitch state needs refreshing.
 * @returns Resolves once the stale announcement is cleaned up (or skipped on delete failure).
 */
export async function handleOfflineStreamerOnStartup(
  streamer: DbStreamerFull,
  groupsWithChanges: Set<number>,
): Promise<void> {
  // Stream ended while bot was offline — liveStates is empty at startup so
  // deleteAnnouncement() would early-return without clearing DB state. Do it directly.
  if (streamer.discord_channel_id && streamer.discord_message_id) {
    try {
      await tryDeleteDiscordMessage(streamer.discord_channel_id, streamer.discord_message_id);
    } catch {
      // Delete failed (already logged) — skip DB clear to avoid orphaning the announcement
      return;
    }
  }
  await clearStreamerLive(streamer.id);
  groupsWithChanges.add(streamer.group.id);
}

/**
 * Runs the one-time live-status reconciliation performed when the bot starts:
 * fetches current live streams for all tracked streamers, reconciles each
 * streamer's announcement state via {@link handleLiveStreamerOnStartup} or
 * {@link handleOfflineStreamerOnStartup}, then refreshes MultiTwitch fields for
 * every stream group that changed.
 * @param liveStates - Map of live streamer states, keyed by streamer DB row id (mutated in place).
 * @param loginToUserId - Map of lowercased Twitch login to Twitch user ID for all tracked streamers.
 * @param streamersData - Full streamer records (including stream group) from the database.
 * @returns Resolves once startup reconciliation and MultiTwitch refresh are complete.
 */
export async function performStartupLiveCheck(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  streamersData: DbStreamerFull[],
): Promise<void> {
  const userIds = Array.from(loginToUserId.values());
  if (userIds.length === 0) return;

  let liveStreams: TwitchStream[];
  try {
    liveStreams = await getStreams(userIds);
  } catch (err) {
    log.error('Startup live-check failed:', err);
    return;
  }

  const liveByUserId = new Map(
    liveStreams.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
  );

  const groupsWithChanges = new Set<number>();

  // Each streamer's reconciliation (a different Discord message/channel) is independent, and
  // handleLiveStreamerOnStartup/handleOfflineStreamerOnStartup already isolate their own
  // errors internally — so these run concurrently instead of one streamer at a time.
  await Promise.allSettled(
    streamersData.map(async (streamer) => {
      const loginKey = streamer.twitch_name?.toLowerCase();
      const userId = loginKey ? loginToUserId.get(loginKey) : undefined;
      if (!userId) return;

      const liveStream = liveByUserId.get(userId);

      if (liveStream) {
        await handleLiveStreamerOnStartup(liveStates, streamer, liveStream, groupsWithChanges);
      } else if (streamer.discord_message_id) {
        await handleOfflineStreamerOnStartup(streamer, groupsWithChanges);
      }
    }).map((work) => work.catch((err) => log.error('Startup reconciliation failed for a streamer:', err))),
  );

  // Each group's MultiTwitch refresh is independent of the others.
  await Promise.allSettled(
    Array.from(groupsWithChanges, (gid) =>
      updateMultitwitch(gid, liveStates).catch((err) => log.error(`MultiTwitch refresh failed for group ${gid}:`, err))),
  );
}
