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
  currentStream: TwitchStream;
  offlineTimer: ReturnType<typeof setTimeout> | null;
}

export interface DiscordEmbedPreview {
  title: string;
  url: string;
  color: string;
  fields: Array<{ name: string; value: string }>;
  imageUrl: string;
  footer: string | null;
}

export interface DiscordMessagePreview {
  content: string;
  embed: DiscordEmbedPreview;
}

export interface MultiTwitchPreview {
  enabled: boolean;
  applicable: boolean;
  participants: string[];
  url: string | null;
  renderedFooter: string | null;
}

interface MultiTwitchContext {
  statesByGroupId: Map<number, LiveState[]>;
  participantsByGroupAndGame: Map<string, string[]>;
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
let currentPollPromise: Promise<void> = Promise.resolve();

// ─── Template helpers ─────────────────────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function getStreamUrl(login: string): string {
  return `https://www.twitch.tv/${login}`;
}

function getThumbnailUrl(stream: TwitchStream): string {
  return stream.thumbnail_url
    .replace('{width}', '640')
    .replace('{height}', '360');
}

function buildEmbedPreview(stream: TwitchStream, footer?: string): DiscordEmbedPreview {
  return {
    title: stream.title,
    url: getStreamUrl(stream.user_login),
    color: '#9146FF',
    fields: [{ name: 'Game', value: stream.game_name || 'Unknown' }],
    imageUrl: getThumbnailUrl(stream),
    footer: footer || null,
  };
}

function buildEmbed(stream: TwitchStream, footer?: string): EmbedBuilder {
  const preview = buildEmbedPreview(stream, footer);

  const embed = new EmbedBuilder()
    .setTitle(preview.title)
    .setURL(preview.url)
    .setColor(0x9146ff)
    .addFields(...preview.fields)
    .setImage(preview.imageUrl);

  if (preview.footer) embed.setFooter({ text: preview.footer });
  return embed;
}

function templateVars(login: string, stream: TwitchStream, multitwitch?: string): Record<string, string> {
  return {
    streamer: login,
    game: stream.game_name || 'Unknown',
    title: stream.title,
    url: getStreamUrl(login),
    multitwitch: multitwitch ?? '',
  };
}

function groupGameKey(groupId: number, game: string): string {
  return `${groupId}::${game.toLowerCase()}`;
}

function buildMultiTwitchContext(states: Iterable<LiveState>): MultiTwitchContext {
  const statesByGroupId = new Map<number, LiveState[]>();
  const participantSets = new Map<string, Set<string>>();

  for (const state of states) {
    const groupStates = statesByGroupId.get(state.groupId);
    if (groupStates) {
      groupStates.push(state);
    } else {
      statesByGroupId.set(state.groupId, [state]);
    }

    const key = groupGameKey(state.groupId, state.currentGame);
    const participants = participantSets.get(key);
    if (participants) {
      participants.add(state.login);
    } else {
      participantSets.set(key, new Set([state.login]));
    }
  }

  const participantsByGroupAndGame = new Map<string, string[]>();
  for (const [key, participants] of participantSets.entries()) {
    participantsByGroupAndGame.set(key, Array.from(participants).sort((left, right) => left.localeCompare(right)));
  }

  return { statesByGroupId, participantsByGroupAndGame };
}

function getMultitwitchPreview(state: LiveState, context?: MultiTwitchContext): MultiTwitchPreview {
  const participants = context?.participantsByGroupAndGame.get(groupGameKey(state.groupId, state.currentGame));
  const applicable = !!participants && participants.length >= 2;

  if (!state.group.multi_twitch || !applicable) {
    return {
      enabled: state.group.multi_twitch,
      applicable: false,
      participants: [state.login],
      url: null,
      renderedFooter: null,
    };
  }

  const url = `https://www.multitwitch.tv/${participants.join('/')}`;
  const renderedFooter = fillTemplate(state.group.multi_twitch_message, { multitwitch: url }) || null;

  return {
    enabled: true,
    applicable: true,
    participants,
    url,
    renderedFooter,
  };
}

function buildMessagePreview(
  state: LiveState,
  templateKey: 'live_message' | 'new_game_message',
  multiTwitch?: MultiTwitchPreview,
): DiscordMessagePreview {
  const stream = state.currentStream;
  const resolvedMultiTwitch = multiTwitch ?? getMultitwitchPreview(state);
  const template = templateKey === 'new_game_message'
    ? state.group.new_game_message
    : state.group.live_message;
  const vars = templateVars(state.login, stream, resolvedMultiTwitch.url ?? undefined);

  return {
    content: fillTemplate(template, vars),
    embed: buildEmbedPreview(stream, resolvedMultiTwitch.renderedFooter ?? undefined),
  };
}

// ─── Multitwitch ──────────────────────────────────────────────────────────────

async function updateMultitwitch(groupId: number): Promise<void> {
  if (!getMonitorEnabled() || !discordClient) return;

  const groupLive = Array.from(liveStates.values()).filter((s) => s.groupId === groupId);
  const context = buildMultiTwitchContext(groupLive);

  for (const state of groupLive) {
    if (!state.messageId || !state.channelId) continue;
    const multiTwitch = getMultitwitchPreview(state, context);
    const footer = multiTwitch.renderedFooter ?? undefined;

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
  // Key by DB row id so each streamer×group pair has independent state
  const key = String(streamerData.id);
  const login = stream.user_login.toLowerCase();
  const group = streamerData.group;

  if (!getMonitorEnabled() || !discordClient) {
    // Track state without posting to Discord
    liveStates.set(key, {
      streamerId: streamerData.id,
      groupId: group.id,
      group,
      login,
      messageId: null,
      channelId: null,
      currentGame: stream.game_name,
      title: stream.title,
      currentStream: stream,
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
      login,
      messageId: msg.id,
      channelId: msg.channelId,
      currentGame: stream.game_name,
      title: stream.title,
      currentStream: stream,
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
  state.currentStream = stream;

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

async function deleteAnnouncement(stateKey: string): Promise<void> {
  const state = liveStates.get(stateKey);
  if (!state || !state.messageId || !state.channelId) {
    liveStates.delete(stateKey);
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
      console.error(`[TwitchMonitor] Failed to delete message for ${state.login}:`, err);
    }
  }

  await clearStreamerLive(state.streamerId);
  const groupId = state.groupId;
  liveStates.delete(stateKey);
  await updateMultitwitch(groupId);
}

// ─── Offline grace period ────────────────────────────────────────────────────

async function handleStreamOffline(login: string): Promise<void> {
  const key = login.toLowerCase();
  // Collect all state entries for this login (one per group they belong to)
  const matchingEntries = Array.from(liveStates.entries()).filter(([, s]) => s.login === key);
  if (matchingEntries.length === 0) return;

  for (const [stateKey, state] of matchingEntries) {
    if (state.offlineTimer) clearTimeout(state.offlineTimer);

    state.offlineTimer = setTimeout(async () => {
      let currentState: LiveState | undefined;
      try {
        // Re-fetch current state to guard against stale closure after monitor restart.
        currentState = liveStates.get(stateKey);
        if (!currentState) return;

        const userId = loginToUserId.get(key);
        if (!userId) return;

        const streams = await getStreams([userId]);
        const isLive = streams.some((s) => s.user_id === userId && s.type === 'live');

        if (!isLive) {
          await deleteAnnouncement(stateKey);
          console.log(`[TwitchMonitor] ${login} confirmed offline — announcement removed`);
        }
      } catch (err) {
        console.error(`[TwitchMonitor] Offline-check failed for ${key} (${stateKey}):`, err);
      } finally {
        if (currentState) currentState.offlineTimer = null;
      }
    }, OFFLINE_GRACE_MS);
  }

  console.log(`[TwitchMonitor] ${login} went offline — grace period started`);
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
              liveStates.set(String(streamer.id), {
                streamerId: streamer.id,
                groupId: streamer.group.id,
                group: streamer.group,
                login: streamer.name.toLowerCase(),
                messageId: streamer.discord_message_id,
                channelId: streamer.discord_channel_id,
                currentGame: liveStream.game_name,
                title: liveStream.title,
                currentStream: liveStream,
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
          liveStates.set(String(streamer.id), {
            streamerId: streamer.id,
            groupId: streamer.group.id,
            group: streamer.group,
            login: streamer.name.toLowerCase(),
            messageId: streamer.discord_message_id,
            channelId: streamer.discord_channel_id,
            currentGame: liveStream.game_name,
            title: liveStream.title,
            currentStream: liveStream,
            offlineTimer: null,
          });
          continue;
        }
      }
      // Post fresh announcement
      await postAnnouncement(streamer, liveStream);
    } else if (hasStoredMsg) {
      // Stream ended while bot was offline — liveStates is empty at startup so
      // deleteAnnouncement() would early-return without clearing DB state. Do it directly.
      if (discordClient && streamer.discord_channel_id && streamer.discord_message_id) {
        try {
          const ch = await discordClient.channels.fetch(streamer.discord_channel_id);
          if (ch && ch.isTextBased()) {
            const msg = await ch.messages.fetch(streamer.discord_message_id).catch(() => null);
            if (msg) await msg.delete();
          }
        } catch { /* already deleted */ }
      }
      await clearStreamerLive(streamer.id);
      groupsWithChanges.add(streamer.group.id);
    }
  }

  for (const gid of groupsWithChanges) {
    await updateMultitwitch(gid);
  }
}

// ─── Polling ───────────────────────────────────────────────────────────────

async function pollStreams(): Promise<void> {
  if (pollRunning || streamersData.length === 0) return;
  pollRunning = true;
  currentPollPromise = (async () => {
  try {
    const userIds = Array.from(loginToUserId.values());
    if (userIds.length === 0) return;

    const liveStreams = await getStreams(userIds);
    const liveByUserId = new Map(
      liveStreams.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
    );

    for (const streamer of streamersData) {
      const loginKey = streamer.name.toLowerCase();
      const stateKey = String(streamer.id);
      const userId = loginToUserId.get(loginKey);
      if (!userId) continue;

      const pollStream = liveByUserId.get(userId);
      const existing = liveStates.get(stateKey);

      if (pollStream) {
        if (existing?.offlineTimer) {
          // Came back during grace period — cancel offline timers for all groups this login belongs to
          for (const state of liveStates.values()) {
            if (state.login === loginKey && state.offlineTimer) {
              clearTimeout(state.offlineTimer);
              state.offlineTimer = null;
            }
          }
          console.log(`[TwitchMonitor] ${loginKey} came back — offline timer(s) cancelled`);
        }
        const isNew = !liveStates.has(stateKey);
        if (isNew || (existing && !existing.messageId)) {
          // Went live, or state exists with no Discord message (e.g. Discord wasn't ready at startup)
          await postAnnouncement(streamer, pollStream);
          if (isNew) console.log(`[TwitchMonitor] ${loginKey} went live in group ${streamer.group.name}`);
        } else if (existing && existing.currentGame !== pollStream.game_name) {
          // Game changed
          await editAnnouncement(existing, pollStream, 'new_game_message');
          console.log(`[TwitchMonitor] ${loginKey} game changed to ${pollStream.game_name}`);
        } else if (existing) {
          // Still live — keep title in sync
          existing.currentGame = pollStream.game_name;
          existing.title = pollStream.title;
          existing.currentStream = pollStream;
        }
      } else if (existing && !existing.offlineTimer) {
        // Appears offline — start grace period (handleStreamOffline handles all groups for this login)
        await handleStreamOffline(loginKey);
      }
    }
  } catch (err) {
    console.error('[TwitchMonitor] Poll error:', err);
  } finally {
    pollRunning = false;
  }
  })();
  await currentPollPromise;
}

// ─── Internal teardown ────────────────────────────────────────────────────────

async function teardown(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  // Wait for any in-flight poll to complete before callers mutate liveStates.
  await currentPollPromise;
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
 * Stops the monitor on process exit without touching Discord messages.
 * The startup live-check on next boot will re-sync any stale announcements.
 */
export async function stopTwitchMonitor(): Promise<void> {
  await teardown();
  liveStates.clear();
  loginToUserId.clear();
  streamersData = [];
  console.log('[TwitchMonitor] Stopped — Discord messages preserved for restart sync');
}

/**
 * Shuts down the monitor and deletes all live Discord announcement messages.
 * Only call this if you intentionally want to clear all announcements (e.g. disabling the feature permanently).
 */
export async function shutdownTwitchMonitor(): Promise<void> {
  await teardown();

  // Delete all live announcements and clear DB state
  const stateKeys = Array.from(liveStates.keys());
  for (const key of stateKeys) {
    await deleteAnnouncement(key);
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
  streamerId: number;
  login: string;
  twitchUrl: string;
  groupId: number;
  groupName: string;
  groupDiscordChannelId: string;
  multiTwitchEnabled: boolean;
  deleteOldPosts: boolean;
  currentGame: string;
  title: string;
  messageId: string | null;
  channelId: string | null;
  multiTwitch: MultiTwitchPreview;
  liveMessagePreview: DiscordMessagePreview;
  gameChangePreview: DiscordMessagePreview;
}

export function getLiveStates(): LiveStateSnapshot[] {
  const states = Array.from(liveStates.values());
  const multiTwitchContext = buildMultiTwitchContext(states);

  return states
    .map((state) => {
      const multiTwitch = getMultitwitchPreview(state, multiTwitchContext);

      return {
        streamerId: state.streamerId,
        login: state.login,
        twitchUrl: getStreamUrl(state.login),
        groupId: state.groupId,
        groupName: state.group.name,
        groupDiscordChannelId: state.group.discord_channel,
        multiTwitchEnabled: state.group.multi_twitch,
        deleteOldPosts: state.group.delete_old_posts,
        currentGame: state.currentGame,
        title: state.title,
        messageId: state.messageId,
        channelId: state.channelId,
        multiTwitch,
        liveMessagePreview: buildMessagePreview(state, 'live_message', multiTwitch),
        gameChangePreview: buildMessagePreview(state, 'new_game_message', multiTwitch),
      };
    })
    .sort((left, right) => {
      const groupCompare = left.groupName.localeCompare(right.groupName);
      if (groupCompare !== 0) return groupCompare;
      return left.login.localeCompare(right.login);
    });
}

/**
 * Posts (or edits) Discord announcements for all currently tracked live streams.
 * Called when Discord posts are re-enabled after being disabled.
 */
export async function catchUpDiscordPosts(): Promise<void> {
  if (!discordClient) return;

  const states = Array.from(liveStates.values());
  // Batch all live-state user IDs into a single Helix request instead of one per streamer.
  const allUserIds = states
    .map((s) => loginToUserId.get(s.login))
    .filter((id): id is string => id !== undefined);

  let streamsByUserId = new Map<string, TwitchStream>();
  if (allUserIds.length > 0) {
    try {
      const fetched = await getStreams(allUserIds);
      streamsByUserId = new Map(
        fetched.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
      );
    } catch (err) {
      console.error('[TwitchMonitor] Catch-up getStreams failed:', err);
      return;
    }
  }

  for (const state of states) {
    const streamerInfo = streamersData.find((s) => s.id === state.streamerId);
    if (!streamerInfo) continue;
    const userId = loginToUserId.get(state.login);
    if (!userId) continue;

    try {
      const stream = streamsByUserId.get(userId);

      if (!stream) {
        // Went offline while posts were disabled — clean up any stale message
        await deleteAnnouncement(String(state.streamerId));
        continue;
      }

      if (state.messageId && state.channelId) {
        // Existing Discord message — edit it with current stream info
        await editAnnouncement(state, stream, 'live_message');
      } else {
        // No message yet — post fresh
        await postAnnouncement(streamerInfo, stream);
      }
    } catch (err) {
      console.error(`[TwitchMonitor] Catch-up post failed for ${state.login}:`, err);
    }
  }
}
