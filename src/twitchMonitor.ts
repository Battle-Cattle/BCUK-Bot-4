import { EmbedBuilder, TextChannel } from 'discord.js';
import { discordClient } from './discordBot';
import { getMonitorEnabled } from './monitorSettings';
import {
  getAllStreamersWithGroups,
  setStreamerLive,
  clearStreamerLive,
  DbStreamerFull,
  DbStreamGroup,
} from './db';
import { getUsers, getStreams, TwitchStream } from './twitchApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LiveState {
  streamerId: number;
  groupId: number;
  group: DbStreamGroup;
  login: string;
  messageId: string | null;
  channelId: string | null;
  currentGame: string;
  title: string;
  offlineTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Module-level state ──────────────────────────────────────────────────────

/** Keyed by lowercase broadcaster login */
const liveStates = new Map<string, LiveState>();
let loginToUserId = new Map<string, string>();
let streamersData: DbStreamerFull[] = [];

const POLL_INTERVAL_MS = 60_000;
const OFFLINE_GRACE_MS = 5 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;

// ─── Template helpers ─────────────────────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function buildEmbed(stream: TwitchStream, footer?: string): EmbedBuilder {
  const thumbnailUrl = stream.thumbnail_url
    .replace('{width}', '640')
    .replace('{height}', '360');

  const embed = new EmbedBuilder()
    .setTitle(stream.title)
    .setURL(`https://www.twitch.tv/${stream.user_login}`)
    .setColor(0x9146ff)
    .addFields({ name: 'Game', value: stream.game_name || 'Unknown' })
    .setImage(thumbnailUrl);

  if (footer) embed.setFooter({ text: footer });
  return embed;
}

function templateVars(login: string, stream: TwitchStream, multitwitch?: string): Record<string, string> {
  return {
    streamer: login,
    game: stream.game_name || 'Unknown',
    title: stream.title,
    url: `https://www.twitch.tv/${login}`,
    multitwitch: multitwitch ?? '',
  };
}

// ─── Multitwitch ──────────────────────────────────────────────────────────────

async function updateMultitwitch(groupId: number): Promise<void> {
  if (!getMonitorEnabled() || !discordClient) return;

  const groupLive = Array.from(liveStates.values()).filter((s) => s.groupId === groupId);

  for (const state of groupLive) {
    if (!state.messageId || !state.channelId) continue;

    const sameGame = groupLive.filter(
      (s) => s.currentGame === state.currentGame && s.login !== state.login,
    );

    let footer: string | undefined;
    if (state.group.multi_twitch && sameGame.length >= 1) {
      const logins = [state.login, ...sameGame.map((s) => s.login)];
      const multitwitchUrl = `https://www.multitwitch.tv/${logins.join('/')}`;
      footer = fillTemplate(state.group.multi_twitch_message, { multitwitch: multitwitchUrl });
    }

    try {
      const channel = await discordClient.channels.fetch(state.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const message = await channel.messages.fetch(state.messageId);
      const existing = message.embeds[0];
      if (!existing) continue;

      const updated = EmbedBuilder.from(existing);
      if (footer) {
        updated.setFooter({ text: footer });
      } else {
        updated.setFooter(null);
      }
      await message.edit({ embeds: [updated] });
    } catch (err) {
      console.error(`[TwitchMonitor] Failed to update multitwitch for ${state.login}:`, err);
    }
  }
}

// ─── Announcement helpers ─────────────────────────────────────────────────────

async function postAnnouncement(streamerData: DbStreamerFull, stream: TwitchStream): Promise<void> {
  const key = stream.user_login.toLowerCase();
  const group = streamerData.group;

  if (!getMonitorEnabled() || !discordClient) {
    // Track state without posting to Discord
    liveStates.set(key, {
      streamerId: streamerData.id,
      groupId: group.id,
      group,
      login: key,
      messageId: null,
      channelId: null,
      currentGame: stream.game_name,
      title: stream.title,
      offlineTimer: null,
    });
    return;
  }

  const vars = templateVars(stream.user_login, stream);
  const content = fillTemplate(group.live_message, vars);
  const embed = buildEmbed(stream);

  try {
    const channel = await discordClient.channels.fetch(group.discord_channel);
    if (!channel || !channel.isTextBased()) {
      console.error(`[TwitchMonitor] Channel ${group.discord_channel} not found or not text-based`);
      return;
    }
    const textChannel = channel as TextChannel;
    const msg = await textChannel.send({ content, embeds: [embed] });

    liveStates.set(key, {
      streamerId: streamerData.id,
      groupId: group.id,
      group,
      login: key,
      messageId: msg.id,
      channelId: msg.channelId,
      currentGame: stream.game_name,
      title: stream.title,
      offlineTimer: null,
    });

    await setStreamerLive(streamerData.id, msg.id, msg.channelId, stream.game_name);
    await updateMultitwitch(group.id);
  } catch (err) {
    console.error(`[TwitchMonitor] Failed to post announcement for ${stream.user_login}:`, err);
  }
}

async function editAnnouncement(
  state: LiveState,
  stream: TwitchStream,
  templateKey: 'live_message' | 'new_game_message',
): Promise<void> {
  // Always update in-memory state so liveStates stays current even when posts are disabled
  state.currentGame = stream.game_name;
  state.title = stream.title;

  if (!getMonitorEnabled() || !discordClient || !state.messageId || !state.channelId) return;

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
      } catch { /* already deleted */ }
      const msg = await textChannel.send({ content, embeds: [embed] });
      state.messageId = msg.id;
      state.channelId = msg.channelId;
    } else {
      const message = await textChannel.messages.fetch(state.messageId);
      await message.edit({ content, embeds: [embed] });
    }

    await setStreamerLive(state.streamerId, state.messageId!, state.channelId!, stream.game_name);
    await updateMultitwitch(group.id);
  } catch (err) {
    console.error(`[TwitchMonitor] Failed to edit announcement for ${state.login}:`, err);
  }
}

async function deleteAnnouncement(login: string): Promise<void> {
  const state = liveStates.get(login);
  if (!state || !state.messageId || !state.channelId) {
    liveStates.delete(login);
    return;
  }

  if (discordClient) {
    try {
      const channel = await discordClient.channels.fetch(state.channelId);
      if (channel && channel.isTextBased()) {
        const msg = await channel.messages.fetch(state.messageId).catch(() => null);
        if (msg) await msg.delete();
      }
    } catch (err) {
      console.error(`[TwitchMonitor] Failed to delete message for ${login}:`, err);
    }
  }

  await clearStreamerLive(state.streamerId);
  const groupId = state.groupId;
  liveStates.delete(login);
  await updateMultitwitch(groupId);
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleStreamOnline(login: string): Promise<void> {
  const key = login.toLowerCase();
  const streamerInfo = streamersData.find((s) => s.name.toLowerCase() === key);
  if (!streamerInfo) return;

  // If there's a pending offline timer, the streamer came back before the grace period expired
  const existing = liveStates.get(key);
  if (existing?.offlineTimer) {
    clearTimeout(existing.offlineTimer);
    existing.offlineTimer = null;
    console.log(`[TwitchMonitor] ${login} came back online — offline timer cancelled`);
    return;
  }

  const userId = loginToUserId.get(key);
  if (!userId) return;

  const streams = await getStreams([userId]);
  const stream = streams.find((s) => s.user_id === userId && s.type === 'live');
  if (!stream) {
    console.warn(`[TwitchMonitor] ${login} stream.online fired but Helix shows not live yet`);
    return;
  }

  await postAnnouncement(streamerInfo, stream);
  console.log(`[TwitchMonitor] ${login} went live — announcement posted`);
}

async function handleStreamOffline(login: string): Promise<void> {
  const key = login.toLowerCase();
  const state = liveStates.get(key);
  if (!state) return;

  if (state.offlineTimer) clearTimeout(state.offlineTimer);

  state.offlineTimer = setTimeout(async () => {
    state.offlineTimer = null;
    const userId = loginToUserId.get(key);
    if (!userId) return;

    const streams = await getStreams([userId]);
    const isLive = streams.some((s) => s.user_id === userId && s.type === 'live');

    if (!isLive) {
      await deleteAnnouncement(key);
      console.log(`[TwitchMonitor] ${login} confirmed offline — announcement removed`);
    }
    // If live again, stream.online will have already cleared the timer
  }, OFFLINE_GRACE_MS);

  console.log(`[TwitchMonitor] ${login} went offline — grace period started`);
}

async function handleChannelUpdate(login: string): Promise<void> {
  const key = login.toLowerCase();
  const state = liveStates.get(key);
  if (!state) return; // Ignore updates for streamers that aren't live

  const userId = loginToUserId.get(key);
  if (!userId) return;

  const streams = await getStreams([userId]);
  const stream = streams.find((s) => s.user_id === userId && s.type === 'live');
  if (!stream) return; // Stream is offline — ignore game/title changes

  await editAnnouncement(state, stream, 'new_game_message');
  console.log(`[TwitchMonitor] ${login} game/title updated — announcement edited`);
}

// ─── Startup live-check ───────────────────────────────────────────────────────

async function performStartupLiveCheck(): Promise<void> {
  const userIds = Array.from(loginToUserId.values());
  if (userIds.length === 0) return;

  let liveStreams: TwitchStream[] = [];
  try {
    liveStreams = await getStreams(userIds);
  } catch (err) {
    console.error('[TwitchMonitor] Startup live-check failed:', err);
    return;
  }

  const liveByUserId = new Map(
    liveStreams.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
  );

  const groupsWithChanges = new Set<number>();

  for (const streamer of streamersData) {
    const userId = loginToUserId.get(streamer.name.toLowerCase());
    if (!userId) continue;

    const liveStream = liveByUserId.get(userId);
    const hasStoredMsg = !!streamer.discord_message_id;

    if (liveStream) {
      if (hasStoredMsg && streamer.discord_channel_id) {
        if (discordClient && getMonitorEnabled()) {
          // Try to edit the existing message
          try {
            const channel = await discordClient.channels.fetch(streamer.discord_channel_id);
            if (channel && channel.isTextBased()) {
              const vars = templateVars(streamer.name, liveStream);
              const content = fillTemplate(streamer.group.live_message, vars);
              const embed = buildEmbed(liveStream);
              const message = await channel.messages.fetch(streamer.discord_message_id!);
              await message.edit({ content, embeds: [embed] });
              liveStates.set(streamer.name.toLowerCase(), {
                streamerId: streamer.id,
                groupId: streamer.group.id,
                group: streamer.group,
                login: streamer.name.toLowerCase(),
                messageId: streamer.discord_message_id,
                channelId: streamer.discord_channel_id,
                currentGame: liveStream.game_name,
                title: liveStream.title,
                offlineTimer: null,
              });
              await setStreamerLive(streamer.id, streamer.discord_message_id!, streamer.discord_channel_id!, liveStream.game_name);
              groupsWithChanges.add(streamer.group.id);
              continue;
            }
          } catch {
            // Message no longer exists — fall through to post fresh
          }
        } else {
          // Disabled or no client: restore stored IDs into liveStates without touching Discord
          liveStates.set(streamer.name.toLowerCase(), {
            streamerId: streamer.id,
            groupId: streamer.group.id,
            group: streamer.group,
            login: streamer.name.toLowerCase(),
            messageId: streamer.discord_message_id,
            channelId: streamer.discord_channel_id,
            currentGame: liveStream.game_name,
            title: liveStream.title,
            offlineTimer: null,
          });
          groupsWithChanges.add(streamer.group.id);
          continue;
        }
      }
      // Post fresh announcement
      await postAnnouncement(streamer, liveStream);
      groupsWithChanges.add(streamer.group.id);
    } else if (hasStoredMsg) {
      // Stream ended while bot was offline — clean up
      await deleteAnnouncement(streamer.name.toLowerCase());
      // deleteAnnouncement also calls clearStreamerLive + updateMultitwitch
      groupsWithChanges.add(streamer.group.id);
    }
  }

  for (const gid of groupsWithChanges) {
    await updateMultitwitch(gid);
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

// ─── Polling ───────────────────────────────────────────────────────────────

async function pollStreams(): Promise<void> {
  if (pollRunning || streamersData.length === 0) return;
  pollRunning = true;
  try {
    const userIds = Array.from(loginToUserId.values());
    if (userIds.length === 0) return;

    const liveStreams = await getStreams(userIds);
    const liveByUserId = new Map(
      liveStreams.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
    );

    for (const streamer of streamersData) {
      const key = streamer.name.toLowerCase();
      const userId = loginToUserId.get(key);
      if (!userId) continue;

      const pollStream = liveByUserId.get(userId);
      const existing = liveStates.get(key);

      if (pollStream) {
        if (existing?.offlineTimer) {
          // Came back during grace period — cancel the offline timer
          clearTimeout(existing.offlineTimer);
          existing.offlineTimer = null;
          console.log(`[TwitchMonitor] ${key} came back — offline timer cancelled`);
        }
        if (!liveStates.has(key)) {
          // Went live
          await postAnnouncement(streamer, pollStream);
          console.log(`[TwitchMonitor] ${key} went live`);
        } else if (existing && existing.currentGame !== pollStream.game_name) {
          // Game changed
          await editAnnouncement(existing, pollStream, 'new_game_message');
          console.log(`[TwitchMonitor] ${key} game changed to ${pollStream.game_name}`);
        } else if (existing) {
          // Still live — keep title in sync
          existing.title = pollStream.title;
        }
      } else if (existing && !existing.offlineTimer) {
        // Appears offline — start grace period
        await handleStreamOffline(key);
      }
    }
  } catch (err) {
    console.error('[TwitchMonitor] Poll error:', err);
  } finally {
    pollRunning = false;
  }
}

// ─── Internal teardown ────────────────────────────────────────────────────────

async function teardown(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const state of liveStates.values()) {
    if (state.offlineTimer) clearTimeout(state.offlineTimer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startTwitchMonitor(): Promise<void> {
  streamersData = await getAllStreamersWithGroups();
  if (streamersData.length === 0) {
    console.warn('[TwitchMonitor] No streamers configured in DB — nothing to monitor');
  }

  const logins = streamersData.map((s) => s.name);
  const users = await getUsers(logins);
  loginToUserId = new Map(users.map((u) => [u.login.toLowerCase(), u.id]));

  // Startup live-check: sync with any streams that went live/offline while bot was down
  await performStartupLiveCheck();

  // Begin polling every 60 s
  pollTimer = setInterval(() => {
    pollStreams().catch((err) => console.error('[TwitchMonitor] Poll error:', err));
  }, POLL_INTERVAL_MS);
  console.log(`[TwitchMonitor] Polling ${loginToUserId.size} streamer(s) every ${POLL_INTERVAL_MS / 1000}s`);
}

/**
 * Shuts down the monitor and deletes all live Discord announcement messages.
 * Used on process exit to clean up Discord messages.
 */
export async function shutdownTwitchMonitor(): Promise<void> {
  await teardown();

  // Delete all live announcements and clear DB state
  const logins = Array.from(liveStates.keys());
  for (const login of logins) {
    await deleteAnnouncement(login);
  }

  liveStates.clear();
  loginToUserId.clear();
  streamersData = [];
  console.log('[TwitchMonitor] Shutdown complete — all live messages deleted');
}

/**
 * Restarts the monitor without deleting live messages.
 * The startup live-check will re-sync with any posts made before the restart.
 */
export async function restartTwitchMonitor(): Promise<void> {
  console.log('[TwitchMonitor] Restarting...');
  await teardown();

  // Don't delete messages — startup live-check handles re-syncing
  liveStates.clear();
  loginToUserId.clear();
  streamersData = [];

  await startTwitchMonitor();
}

// ─── Live state snapshot (for web panel) ─────────────────────────────────────

export interface LiveStateSnapshot {
  login: string;
  groupId: number;
  groupName: string;
  currentGame: string;
  title: string;
  messageId: string | null;
  channelId: string | null;
}

export function getLiveStates(): LiveStateSnapshot[] {
  return Array.from(liveStates.values()).map((s) => ({
    login: s.login,
    groupId: s.groupId,
    groupName: s.group.name,
    currentGame: s.currentGame,
    title: s.title,
    messageId: s.messageId,
    channelId: s.channelId,
  }));
}

/**
 * Posts (or edits) Discord announcements for all currently tracked live streams.
 * Called when Discord posts are re-enabled after being disabled.
 */
export async function catchUpDiscordPosts(): Promise<void> {
  if (!discordClient) return;
  const groupsToUpdate = new Set<number>();

  for (const state of Array.from(liveStates.values())) {
    const streamerInfo = streamersData.find((s) => s.name.toLowerCase() === state.login);
    if (!streamerInfo) continue;
    const userId = loginToUserId.get(state.login);
    if (!userId) continue;

    try {
      const streams = await getStreams([userId]);
      const stream = streams.find((s) => s.user_id === userId && s.type === 'live');

      if (!stream) {
        // Went offline while posts were disabled — clean up any stale message
        await deleteAnnouncement(state.login);
        groupsToUpdate.add(state.groupId);
        continue;
      }

      if (state.messageId && state.channelId) {
        // Existing Discord message — edit it with current stream info
        await editAnnouncement(state, stream, 'live_message');
      } else {
        // No message yet — post fresh
        await postAnnouncement(streamerInfo, stream);
      }
      groupsToUpdate.add(state.groupId);
    } catch (err) {
      console.error(`[TwitchMonitor] Catch-up post failed for ${state.login}:`, err);
    }
  }

  for (const gid of groupsToUpdate) {
    await updateMultitwitch(gid);
  }
}
