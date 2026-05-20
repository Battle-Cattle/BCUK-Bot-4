import { createLogger } from './logger';
import { getAllStreamersWithGroups, DbStreamerFull } from './db';
import { getUsers, getStreams, TwitchStream } from './twitchApi';
import { LiveState } from './twitchMonitorTypes';
import {
  DiscordMessagePreview,
  buildMessagePreview,
  getStreamUrl,
} from './twitchMonitorEmbed';
import {
  MultiTwitchPreview,
  MultiTwitchGroupInfo,
  buildMultiTwitchContext,
  getMultitwitchPreview,
} from './twitchMonitorMultitwitch';
import {
  postAnnouncement,
  editAnnouncement,
  deleteAnnouncement,
} from './twitchMonitorAnnouncements';
import {
  cancelOfflineTimersForLogin,
  handleStreamOffline,
} from './twitchMonitorOffline';
import { performStartupLiveCheck } from './twitchMonitorStartup';

const log = createLogger('TwitchMonitor');

// ─── Module-level state ──────────────────────────────────────────────────────

/** Keyed by lowercase broadcaster login */
const liveStates = new Map<string, LiveState>();
let loginToUserId = new Map<string, string>();
let streamersData: DbStreamerFull[] = [];

const POLL_INTERVAL_MS = 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let currentPollPromise: Promise<void> = Promise.resolve();

// ─── Polling ───────────────────────────────────────────────────────────────

async function handlePollStreamer(
  streamer: DbStreamerFull,
  liveByUserId: Map<string, TwitchStream>,
): Promise<void> {
  const loginKey = streamer.name.toLowerCase();
  const stateKey = String(streamer.id);
  const userId = loginToUserId.get(loginKey);
  if (!userId) return;

  const pollStream = liveByUserId.get(userId);
  const existing = liveStates.get(stateKey);

  if (pollStream) {
    if (existing?.offlineTimer) {
      // Came back during grace period — cancel offline timers for all groups this login belongs to
      cancelOfflineTimersForLogin(liveStates, loginKey);
      log.info(`${loginKey} came back — offline timer(s) cancelled`);
    }
    const isNew = !liveStates.has(stateKey);
    if (isNew || (existing && !existing.messageId)) {
      // Went live, or state exists with no Discord message (e.g. Discord wasn't ready at startup)
      await postAnnouncement(liveStates, streamer, pollStream);
      if (isNew) log.info(`${loginKey} went live in group ${streamer.group.name}`);
    } else if (existing && existing.currentGame !== pollStream.game_name) {
      // Game changed
      await editAnnouncement(liveStates, existing, pollStream, 'new_game_message');
      log.info(`${loginKey} game changed to ${pollStream.game_name}`);
    } else if (existing) {
      // Still live — keep title in sync
      existing.currentGame = pollStream.game_name;
      existing.title = pollStream.title;
      existing.currentStream = pollStream;
    }
  } else if (existing && !existing.offlineTimer) {
    // Appears offline — start grace period (handleStreamOffline handles all groups for this login)
    await handleStreamOffline(liveStates, loginToUserId, loginKey);
  }
}

async function dispatchStreamerPolls(
  streamers: DbStreamerFull[],
  liveByUserId: Map<string, TwitchStream>,
): Promise<void> {
  // Group rows by login so same-login rows are serialized (shared offline-timer
  // state); different logins run in parallel via Promise.allSettled.
  const byLogin = new Map<string, DbStreamerFull[]>();
  for (const streamer of streamers) {
    const key = streamer.name.toLowerCase();
    const existing = byLogin.get(key);
    if (existing) existing.push(streamer);
    else byLogin.set(key, [streamer]);
  }

  await Promise.allSettled(
    Array.from(byLogin.values()).map(async (group) => {
      for (const streamer of group) {
        try {
          await handlePollStreamer(streamer, liveByUserId);
        } catch (err) {
          log.error(`Error handling streamer poll for ${streamer.name} in group ${streamer.group.name}:`, err);
        }
      }
    }),
  );
}

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
      await dispatchStreamerPolls(streamersData, liveByUserId);
    } catch (err) {
      log.error('Poll error:', err);
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
    log.warn('No streamers configured in DB — nothing to monitor');
  }

  const logins = streamersData.map((s) => s.name);
  const users = await getUsers(logins);
  loginToUserId = new Map(users.map((u) => [u.login.toLowerCase(), u.id]));

  // Startup live-check: sync with any streams that went live/offline while bot was down
  await performStartupLiveCheck(liveStates, loginToUserId, streamersData);

  pollTimer = setInterval(() => {
    pollStreams().catch((err) => log.error('Poll error:', err));
  }, POLL_INTERVAL_MS);
  log.info(`Polling ${loginToUserId.size} streamer(s) every ${POLL_INTERVAL_MS / 1000}s`);
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
  log.info('Stopped — Discord messages preserved for restart sync');
}

/**
 * Shuts down the monitor and deletes all live Discord announcement messages.
 * Only call this if you intentionally want to clear all announcements (e.g. disabling the feature permanently).
 */
export async function shutdownTwitchMonitor(): Promise<void> {
  await teardown();

  // Delete all live announcements and clear DB state
  const stateKeys = Array.from(liveStates.keys());
  let failedDeletes = 0;
  for (const key of stateKeys) {
    try {
      await deleteAnnouncement(liveStates, key);
    } catch (err) {
      failedDeletes++;
      log.error('Shutdown: failed to delete announcement:', err);
    }
  }

  liveStates.clear();
  loginToUserId.clear();
  streamersData = [];
  if (failedDeletes === 0) {
    log.info('Shutdown complete — all live messages deleted');
  } else {
    log.warn(`Shutdown complete with ${failedDeletes} failed delete(s) — some announcements may remain`);
  }
}

/**
 * Restarts the monitor without deleting live messages.
 * The startup live-check will re-sync with any posts made before the restart.
 */
export async function restartTwitchMonitor(): Promise<void> {
  log.info('Restarting...');
  await teardown();

  // Don't delete messages — startup live-check handles re-syncing
  liveStates.clear();
  loginToUserId.clear();
  streamersData = [];

  await startTwitchMonitor();
}

// ─── Multi-twitch URL query (for !multi command) ─────────────────────────────

/**
 * Returns the current multitwitch URL and participant logins for the group that
 * the given channel belongs to, or null if the channel is not live, not in a
 * multitwitch-enabled group, or fewer than two streamers are live in the group.
 */
export function getMultiTwitchDataForChannel(login: string): MultiTwitchGroupInfo | null {
  const loginLower = login.toLowerCase();
  const state = Array.from(liveStates.values()).find((s) => s.login === loginLower);
  if (!state) return null;

  const groupLive = Array.from(liveStates.values()).filter((s) => s.groupId === state.groupId);
  const context = buildMultiTwitchContext(groupLive);
  const preview = getMultitwitchPreview(state, context);

  if (!preview.enabled || !preview.applicable || !preview.url) return null;

  return { url: preview.url, participants: preview.participants };
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
