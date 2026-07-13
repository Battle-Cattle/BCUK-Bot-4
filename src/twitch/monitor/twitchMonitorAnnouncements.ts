import { createLogger } from '../../shared/logger';
import { TextChannel, EmbedBuilder } from 'discord.js';

const log = createLogger('TwitchMonitor');
import { getDiscordClient } from '../../discord/discordBot';
import { getTextChannel, tryDeleteDiscordMessage, tryEditDiscordMessage } from '../../discord/discordUtils';
import { setStreamerLive, clearStreamerLive, DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';
import { LiveState, makeLiveState } from './twitchMonitorTypes';
import { buildEmbed, templateVars } from './twitchMonitorEmbed';
import { updateMultitwitch } from './twitchMonitorMultitwitch';
import { fillTemplate } from '../../shared/textTemplate';

/**
 * Posts a new "now live" announcement message for a streamer and records the
 * resulting message location in both the in-memory live-state map and the DB.
 * No-ops (storing a state with null message fields) if the Discord client isn't ready.
 * @param liveStates - Map of live streamer states, keyed by streamer DB row id.
 * @param streamerData - Full streamer record (including its stream group) from the database.
 * @param stream - The live Twitch stream data.
 * @returns Resolves once the announcement is posted (or skipped) and state is updated.
 */
export async function postAnnouncement(
  liveStates: Map<string, LiveState>,
  streamerData: DbStreamerFull,
  stream: TwitchStream,
): Promise<void> {
  // Key by DB row id so each streamer×group pair has independent state
  const key = String(streamerData.id);
  const group = streamerData.group;

  const discordClient = getDiscordClient();
  if (!discordClient) {
    liveStates.set(key, makeLiveState(streamerData, stream, null, null));
    return;
  }

  const vars = templateVars(stream.user_login, stream);
  const content = fillTemplate(group.live_message, vars, 'keep');
  const embed = buildEmbed(stream);

  try {
    const channel = await getTextChannel(discordClient, group.discord_channel);
    if (!channel) {
      log.error(`Channel ${group.discord_channel} not found or not text-based`);
      return;
    }
    const textChannel = channel as TextChannel;
    const msg = await textChannel.send({ content, embeds: [embed] });

    liveStates.set(key, makeLiveState(streamerData, stream, msg.id, msg.channelId));

    await setStreamerLive(streamerData.id, msg.id, msg.channelId, stream.game_name);
    await updateMultitwitch(group.id, liveStates);
  } catch (err) {
    log.error(`Failed to post announcement for ${stream.user_login}:`, err);
  }
}

/**
 * Sends a fresh announcement message and records its location on `state`. Shared by
 * `editAnnouncement`'s delete-and-repost and edit-fallback-repost branches.
 * @param textChannel - Discord channel to post into.
 * @param content - Rendered message content.
 * @param embed - Rendered stream embed.
 * @param state - Live state to update with the new message's id/channel.
 * @returns Resolves once the message is sent and `state` is updated.
 */
async function repost(textChannel: TextChannel, content: string, embed: EmbedBuilder, state: LiveState): Promise<void> {
  const msg = await textChannel.send({ content, embeds: [embed] });
  state.messageId = msg.id;
  state.channelId = msg.channelId;
}

/**
 * Updates an existing "now live" announcement to reflect a new game/title.
 * Delete+repost (when the group has `delete_old_posts` enabled) is reserved
 * for actual game changes (`templateKey === 'new_game_message'`) — title-only
 * changes are always edited in place so a burst of Twitch `channel.update`
 * notifications during stream start-up can't repeatedly delete and repost the
 * announcement. If the previously-announced message is gone, falls back to
 * posting a fresh one instead of silently failing on every subsequent call.
 * @param liveStates - Map of live streamer states, keyed by streamer DB row id.
 * @param state - Current live state for the streamer being updated.
 * @param stream - The updated Twitch stream data.
 * @param templateKey - Which group template to render: 'live_message' or 'new_game_message'.
 * @returns Resolves once the announcement is edited or reposted and state is updated.
 */
export async function editAnnouncement(
  liveStates: Map<string, LiveState>,
  state: LiveState,
  stream: TwitchStream,
  templateKey: 'live_message' | 'new_game_message',
): Promise<void> {
  state.currentGame = stream.game_name;
  state.title = stream.title;
  state.currentStream = stream;

  const discordClient = getDiscordClient();
  if (!discordClient || !state.messageId || !state.channelId) return;

  const group = state.group;
  const vars = templateVars(state.login, stream);
  const content = fillTemplate(
    templateKey === 'new_game_message' ? group.new_game_message : group.live_message,
    vars,
    'keep',
  );
  const embed = buildEmbed(stream);

  try {
    const channel = await getTextChannel(discordClient, state.channelId);
    if (!channel) return;
    const textChannel = channel as TextChannel;

    if (group.delete_old_posts && templateKey === 'new_game_message') {
      const staleMessageId = state.messageId;
      const staleChannelId = state.channelId;
      await repost(textChannel, content, embed, state);
      try {
        await tryDeleteDiscordMessage(staleChannelId, staleMessageId);
      } catch (err) {
        log.error(`Failed to delete old announcement for ${state.login}, continuing:`, err);
      }
    } else {
      const edited = await tryEditDiscordMessage(discordClient, state.channelId, state.messageId, { content, embeds: [embed] });
      if (!edited) {
        await repost(textChannel, content, embed, state);
      }
    }

    await setStreamerLive(state.streamerId, state.messageId!, state.channelId!, stream.game_name);
    await updateMultitwitch(group.id, liveStates);
  } catch (err) {
    log.error(`Failed to edit announcement for ${state.login}:`, err);
  }
}

/**
 * Removes a streamer's "now live" announcement when they go offline: deletes
 * the Discord message (best-effort) and clears live state from the DB and
 * the in-memory map. DB/state cleanup always runs even if Discord message
 * deletion fails, so a transient Discord API error can't leave the streamer
 * stuck marked as live.
 */
export async function deleteAnnouncement(
  liveStates: Map<string, LiveState>,
  stateKey: string,
): Promise<void> {
  const state = liveStates.get(stateKey);
  if (!state || !state.messageId || !state.channelId) {
    liveStates.delete(stateKey);
    return;
  }

  try {
    await tryDeleteDiscordMessage(state.channelId, state.messageId);
  } catch (err) {
    log.error(`Failed to delete announcement message for streamer ${state.streamerId}, continuing cleanup:`, err);
  }

  await clearStreamerLive(state.streamerId);
  const groupId = state.groupId;
  liveStates.delete(stateKey);
  await updateMultitwitch(groupId, liveStates);
}
