import { createLogger } from './logger';
import { TextChannel } from 'discord.js';

const log = createLogger('TwitchMonitor');
import { getDiscordClient } from './discordBot';
import { isDiscordNotFoundError, tryDeleteDiscordMessage } from './discordUtils';
import { setStreamerLive, clearStreamerLive, DbStreamerFull } from './db';
import { TwitchStream } from './twitchApi';
import { LiveState, makeLiveState } from './twitchMonitorTypes';
import { buildEmbed, fillTemplate, templateVars } from './twitchMonitorEmbed';
import { updateMultitwitch } from './twitchMonitorMultitwitch';

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
      try {
        const old = await textChannel.messages.fetch(state.messageId);
        await old.delete();
      } catch (err) {
        if (!isDiscordNotFoundError(err)) throw err;
      }
      const msg = await textChannel.send({ content, embeds: [embed] });
      state.messageId = msg.id;
      state.channelId = msg.channelId;
    } else {
      const message = await textChannel.messages.fetch(state.messageId);
      await message.edit({ content, embeds: [embed] });
    }

    await setStreamerLive(state.streamerId, state.messageId!, state.channelId!, stream.game_name);
    await updateMultitwitch(group.id, liveStates);
  } catch (err) {
    log.error(`Failed to edit announcement for ${state.login}:`, err);
  }
}

export async function deleteAnnouncement(
  liveStates: Map<string, LiveState>,
  stateKey: string,
): Promise<void> {
  const state = liveStates.get(stateKey);
  if (!state || !state.messageId || !state.channelId) {
    liveStates.delete(stateKey);
    return;
  }

  await tryDeleteDiscordMessage(state.channelId, state.messageId);

  await clearStreamerLive(state.streamerId);
  const groupId = state.groupId;
  liveStates.delete(stateKey);
  await updateMultitwitch(groupId, liveStates);
}
