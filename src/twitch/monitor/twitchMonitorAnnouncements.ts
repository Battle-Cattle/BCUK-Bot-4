import { createLogger } from '../../shared/logger';
import { TextChannel } from 'discord.js';

const log = createLogger('TwitchMonitor');
import { getDiscordClient } from '../../discord/discordBot';
import { isDiscordNotFoundError, tryDeleteDiscordMessage } from '../../discord/discordUtils';
import { setStreamerLive, clearStreamerLive, DbStreamerFull } from '../../db';
import { TwitchStream } from '../twitchApi';
import { LiveState, makeLiveState } from './twitchMonitorTypes';
import { buildEmbed, fillTemplate, templateVars } from './twitchMonitorEmbed';
import { updateMultitwitch } from './twitchMonitorMultitwitch';

/**
 * Posts a new "now live" announcement message for a streamer and records the
 * resulting message location in both the in-memory live-state map and the DB.
 * No-ops (storing a state with null message fields) if the Discord client isn't ready.
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
  const content = fillTemplate(group.live_message, vars);
  const embed = buildEmbed(stream);

  try {
    const channel = await discordClient.channels.fetch(group.discord_channel);
    if (!channel || !channel.isTextBased()) {
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
 * Updates an existing "now live" announcement in place (or replaces it, if the
 * group is configured to delete old posts) to reflect a new game/title. If the
 * previously-announced message is gone, falls back to posting a fresh one
 * instead of silently failing on every subsequent call.
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
  );
  const embed = buildEmbed(stream);

  try {
    const channel = await discordClient.channels.fetch(state.channelId);
    if (!channel || !channel.isTextBased()) return;
    const textChannel = channel as TextChannel;

    if (group.delete_old_posts) {
      const msg = await textChannel.send({ content, embeds: [embed] });
      try {
        await tryDeleteDiscordMessage(state.channelId, state.messageId);
      } catch (err) {
        log.error(`Failed to delete old announcement for ${state.login}, continuing:`, err);
      }
      state.messageId = msg.id;
      state.channelId = msg.channelId;
    } else {
      try {
        const message = await textChannel.messages.fetch(state.messageId);
        await message.edit({ content, embeds: [embed] });
      } catch (err) {
        if (!isDiscordNotFoundError(err)) throw err;
        const msg = await textChannel.send({ content, embeds: [embed] });
        state.messageId = msg.id;
        state.channelId = msg.channelId;
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
