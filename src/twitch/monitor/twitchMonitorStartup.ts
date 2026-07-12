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

export async function performStartupLiveCheck(
  liveStates: Map<string, LiveState>,
  loginToUserId: Map<string, string>,
  streamersData: DbStreamerFull[],
): Promise<void> {
  const userIds = Array.from(loginToUserId.values());
  if (userIds.length === 0) return;

  let liveStreams: TwitchStream[] = [];
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

  for (const streamer of streamersData) {
    const loginKey = streamer.twitch_name?.toLowerCase();
    const userId = loginKey ? loginToUserId.get(loginKey) : undefined;
    if (!userId) continue;

    const liveStream = liveByUserId.get(userId);

    if (liveStream) {
      await handleLiveStreamerOnStartup(liveStates, streamer, liveStream, groupsWithChanges);
    } else if (streamer.discord_message_id) {
      await handleOfflineStreamerOnStartup(streamer, groupsWithChanges);
    }
  }

  for (const gid of groupsWithChanges) {
    await updateMultitwitch(gid, liveStates);
  }
}
