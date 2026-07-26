import { createLogger } from '../../shared/logger';
import { getAllStreamersWithGroups, DbStreamerFull } from '../../db';
import { getUsers, getStreams } from '../twitchApi';
import { LiveStateMap } from './twitchMonitorTypes';
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
import { deleteAnnouncement } from './twitchMonitorAnnouncements';
import { performStartupLiveCheck } from './twitchMonitorStartup';
import { handlePollStreamer, dispatchStreamerPolls, withLoginLock } from './twitchMonitorPoll';

const log = createLogger('TwitchMonitor');

// ─── Module-level state ──────────────────────────────────────────────────────

/** Keyed by streamer DB row id; also indexed by login via {@link LiveStateMap.getByLogin}. */
const liveStates = new LiveStateMap();
let loginToUserId = new Map<string, string>();
let streamersData: DbStreamerFull[] = [];

const POLL_INTERVAL_MS = 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let currentPollPromise: Promise<void> = Promise.resolve();

// ─── Polling ───────────────────────────────────────────────────────────────

/** Polls the Twitch API for all monitored streamers' live status and dispatches the results. No-ops if a poll is already in flight or there are no streamers configured. */
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
      await dispatchStreamerPolls(liveStates, loginToUserId, streamersData, liveByUserId);
    } catch (err) {
      log.error('Poll error:', err);
    } finally {
      pollRunning = false;
    }
  })();
  await currentPollPromise;
}

/**
 * Immediately re-checks a single streamer's live status against the Twitch API,
 * bypassing the poll interval. Used by EventSub stream.online/offline notifications
 * to react faster than the 60s poll while reusing the same announcement and
 * offline-grace-period logic as the poller. The per-login `withLoginLock` ensures this
 * never runs concurrently with a 60s poll tick (or another immediate check) for the same
 * login, so the two triggers can't race on the same `liveStates` entry.
 *
 * @param login - Twitch login name of the streamer to check.
 */
export async function triggerImmediateLiveCheck(login: string): Promise<void> {
  const loginKey = login.toLowerCase();
  const userId = loginToUserId.get(loginKey);
  if (!userId) return;
  const matching = streamersData.filter((s) => s.twitch_name?.toLowerCase() === loginKey);
  if (matching.length === 0) return;

  try {
    const streams = await getStreams([userId]);
    const liveByUserId = new Map(
      streams.filter((s) => s.type === 'live').map((s) => [s.user_id, s]),
    );
    for (const streamer of matching) {
      try {
        await withLoginLock(loginKey, () => handlePollStreamer(liveStates, loginToUserId, streamer, liveByUserId));
      } catch (err) {
        log.error(`Immediate live check failed for ${loginKey} in group ${streamer.group.name}:`, err);
      }
    }
  } catch (err) {
    log.error(`Immediate live check failed for ${loginKey}:`, err);
  }
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

  const logins = streamersData.map((s) => s.twitch_name).filter((n): n is string => n !== null);
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

/**
 * Returns whether `login`'s stream is currently tracked as live by the monitor. Used by timer
 * commands' `require_live` gate.
 * @param login - Twitch login name to check.
 */
export function isChannelLive(login: string): boolean {
  return liveStates.getByLogin(login.toLowerCase()) !== undefined;
}

// ─── Multi-twitch URL query (for !multi command) ─────────────────────────────

/**
 * Returns the current multitwitch URL and participant logins for the group that
 * the given channel belongs to, or null if the channel is not live, not in a
 * multitwitch-enabled group, or fewer than two streamers are live in the group.
 */
export function getMultiTwitchDataForChannel(login: string): MultiTwitchGroupInfo | null {
  const loginLower = login.toLowerCase();
  const state = liveStates.getByLogin(loginLower);
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

/**
 * Returns a snapshot of currently-live streamers scoped to one guild, for the
 * admin web panel. Filtering happens before the multi-twitch context is built
 * so a streamer's "who else is live" grouping never includes another guild's
 * streamers.
 * @param guildId - Guild to return live states for.
 * @returns Live state snapshots for `guildId`'s streamers, sorted by group then login.
 */
export function getLiveStates(guildId: string): LiveStateSnapshot[] {
  const states = Array.from(liveStates.values()).filter((state) => state.group.guild_id === guildId);
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
