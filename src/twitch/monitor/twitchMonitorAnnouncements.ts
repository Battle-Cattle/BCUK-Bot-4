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
import { createMutationQueue } from '../../shared/mutationQueue';

// `setStreamerLive` performs an unconditional row UPDATE with no ordering guarantee against
// another in-flight call for the same streamer — a stale, timed-out withLoginLock operation's
// write could otherwise land after a newer operation's, silently overwriting fresher message/game
// state with stale data. Serializing writes per streamer ID guarantees a write can't start until
// any earlier one has fully completed, and re-checking `isCurrent` immediately before writing
// (inside the queued operation, not just before enqueueing) catches a stale write that reaches its
// turn only after a newer operation has since taken over.
const persistQueue = createMutationQueue<string>();

/**
 * Writes `streamerId`'s live status to the DB, serialized per streamer ID via {@link persistQueue}
 * so overlapping writes for the same streamer can't complete out of order. No-ops if `isCurrent`
 * reports superseded by the time this write reaches the front of the queue.
 * @param streamerId - DB row id of the streamer being written.
 * @param messageId - Discord message id of the live announcement.
 * @param channelId - Discord channel id the announcement was posted in.
 * @param gameName - Current game name to record.
 * @param isCurrent - See `withLoginLock` in twitchMonitorPoll.ts.
 * @returns Resolves once the write has completed or been skipped as stale.
 */
async function persistStreamerLive(streamerId: number, messageId: string, channelId: string, gameName: string, isCurrent: () => boolean): Promise<void> {
  await persistQueue.run(String(streamerId), async () => {
    if (!isCurrent()) return;
    await setStreamerLive(streamerId, messageId, channelId, gameName);
  });
}

/**
 * Posts a new "now live" announcement message for a streamer and records the
 * resulting message location in both the in-memory live-state map and the DB.
 * No-ops (storing a state with null message fields) if the Discord client isn't ready.
 * @param liveStates - Map of live streamer states, keyed by streamer DB row id.
 * @param streamerData - Full streamer record (including its stream group) from the database.
 * @param stream - The live Twitch stream data.
 * @param isCurrent - See `withLoginLock` in twitchMonitorPoll.ts; checked after each `await` so a
 *   caller superseded by a newer same-login operation stops instead of mutating `liveStates` or
 *   writing to the DB with stale context. A Discord message already sent before staleness is
 *   detected can't be un-sent, but nothing further is applied on top of it once stale.
 * @returns Resolves once the announcement is posted (or skipped) and state is updated.
 */
export async function postAnnouncement(
  liveStates: Map<string, LiveState>,
  streamerData: DbStreamerFull,
  stream: TwitchStream,
  isCurrent: () => boolean = () => true,
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
    if (!isCurrent()) return; // superseded while resolving the channel — don't post using stale context
    if (!channel) {
      log.error(`Channel ${group.discord_channel} not found or not text-based`);
      return;
    }
    const textChannel = channel as TextChannel;
    const msg = await textChannel.send({ content, embeds: [embed] });
    if (!isCurrent()) return; // superseded while sending — don't record this message against newer state

    liveStates.set(key, makeLiveState(streamerData, stream, msg.id, msg.channelId));

    await persistStreamerLive(streamerData.id, msg.id, msg.channelId, stream.game_name, isCurrent);
    if (!isCurrent()) return;
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
 * @param isCurrent - See {@link editAnnouncement}; checked after sending so a superseded caller
 *   doesn't record a sent message's id against state a newer operation now owns.
 * @returns Resolves once the message is sent and `state` is updated (or updating is skipped
 *   because the caller has since been superseded).
 */
async function repost(textChannel: TextChannel, content: string, embed: EmbedBuilder, state: LiveState, isCurrent: () => boolean): Promise<void> {
  const msg = await textChannel.send({ content, embeds: [embed] });
  if (!isCurrent()) return;
  state.messageId = msg.id;
  state.channelId = msg.channelId;
}

/** Shared context for {@link publishByDeleteAndRepost}/{@link publishByEditWithFallback}. */
interface PublishContext {
  textChannel: TextChannel;
  content: string;
  embed: EmbedBuilder;
  state: LiveState;
  isCurrent: () => boolean;
}

/**
 * Publishes via delete-old-then-post-new, for `editAnnouncement`'s `delete_old_posts` branch.
 * @param ctx - See {@link PublishContext}.
 * @returns `true` if the repost succeeded and the caller wasn't superseded partway through
 *   (the old message's deletion is best-effort and doesn't affect this — see
 *   {@link editAnnouncement}'s doc). `false` if superseded before the repost could be recorded.
 */
async function publishByDeleteAndRepost(ctx: PublishContext): Promise<boolean> {
  const { textChannel, content, embed, state, isCurrent } = ctx;
  const staleMessageId = state.messageId!;
  const staleChannelId = state.channelId!;
  await repost(textChannel, content, embed, state, isCurrent);
  if (!isCurrent()) return false;
  try {
    await tryDeleteDiscordMessage(staleChannelId, staleMessageId);
  } catch (err) {
    log.error(`Failed to delete old announcement for ${state.login}, continuing:`, err);
  }
  return true;
}

/**
 * Publishes via in-place edit, falling back to a fresh repost if the original message is gone,
 * for `editAnnouncement`'s non-`delete_old_posts` branch.
 * @param ctx - See {@link PublishContext}, plus the Discord client the edit attempt needs.
 * @returns `true` if the edit (or fallback repost) succeeded and the caller wasn't superseded
 *   partway through. `false` otherwise.
 */
async function publishByEditWithFallback(ctx: PublishContext & { discordClient: NonNullable<ReturnType<typeof getDiscordClient>> }): Promise<boolean> {
  const { discordClient, textChannel, content, embed, state, isCurrent } = ctx;
  const edited = await tryEditDiscordMessage(discordClient, state.channelId!, state.messageId!, { content, embeds: [embed] });
  if (!isCurrent()) return false;
  if (edited) return true;
  await repost(textChannel, content, embed, state, isCurrent);
  return isCurrent();
}

/**
 * Resolves `state`'s Discord channel and applies the edit/repost, per `editAnnouncement`'s
 * delete-and-repost vs. edit-in-place-with-fallback-repost rules. Split out from
 * `editAnnouncement` to keep each function's branching (and return-point count) manageable.
 * @param params - Bundles the Discord client, live state, rendered content/embed, which template
 *   was rendered, and the `isCurrent` staleness check (see {@link editAnnouncement}).
 * @returns `true` if the caller should continue on to persisting the new state — the channel was
 *   found and the caller wasn't superseded at any checkpoint. `false` otherwise (channel missing,
 *   or superseded partway through — see {@link editAnnouncement}'s doc for what "superseded" means
 *   for in-flight Discord calls that already can't be undone).
 */
async function publishEditedAnnouncement(params: {
  discordClient: NonNullable<ReturnType<typeof getDiscordClient>>;
  state: LiveState;
  content: string;
  embed: EmbedBuilder;
  templateKey: 'live_message' | 'new_game_message';
  isCurrent: () => boolean;
}): Promise<boolean> {
  const { discordClient, state, content, embed, templateKey, isCurrent } = params;
  const channel = await getTextChannel(discordClient, state.channelId!);
  if (!isCurrent() || !channel) return false;
  const ctx: PublishContext = { textChannel: channel as TextChannel, content, embed, state, isCurrent };

  if (state.group.delete_old_posts && templateKey === 'new_game_message') {
    return publishByDeleteAndRepost(ctx);
  }
  return publishByEditWithFallback({ ...ctx, discordClient });
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
 * @param isCurrent - See `withLoginLock` in twitchMonitorPoll.ts; checked after each `await` so a
 *   caller superseded by a newer same-login operation stops instead of editing/reposting or
 *   writing to the DB with stale context.
 * @returns Resolves once the announcement is edited or reposted and state is updated.
 */
export async function editAnnouncement(
  liveStates: Map<string, LiveState>,
  state: LiveState,
  stream: TwitchStream,
  templateKey: 'live_message' | 'new_game_message',
  isCurrent: () => boolean = () => true,
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
    const published = await publishEditedAnnouncement({ discordClient, state, content, embed, templateKey, isCurrent });
    if (!published) return;

    await persistStreamerLive(state.streamerId, state.messageId!, state.channelId!, stream.game_name, isCurrent);
    if (!isCurrent()) return;
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
