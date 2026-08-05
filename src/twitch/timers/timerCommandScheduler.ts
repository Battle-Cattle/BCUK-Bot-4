import { createLogger } from '../../shared/logger';
import { getAllEnabledTimerCommandsWithChannel, type TimerCommandForScheduler } from '../../db';
import { getMessageCount } from '../twitchChatActivity';
import { resolveSharedChatSessionId } from '../../commands/customCommandHandler';
import { createRuntimeRegistry, type TwitchSendRuntime } from '../../commands/twitchRuntime';
import {
  evaluateFireBlock, logBlockReasonChange, forgetBlockReason, pruneBlockReasonLog, clearBlockReasonLog,
  type TimerRuntimeState,
} from './timerCommandFireGate';

const log = createLogger('TimerCommandScheduler');

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ────────
//
// Same pattern as counterHandler.ts/shoutoutHandler.ts to avoid a circular
// import between twitchBot.ts and this scheduler.

/** Adds a channel → Twitch-user-id lookup to the bare send runtime, needed to resolve Shared Chat sessions for the group cooldown below. */
interface TimerCommandsRuntime extends TwitchSendRuntime {
  getLoginUserIds: () => ReadonlyMap<string, string>;
}

const timerCommandsRuntime = createRuntimeRegistry<TimerCommandsRuntime>();

/** Stores the Twitch chat runtime used to post timer messages. Call once from index.ts after the Twitch bot is ready. */
export function registerTimerCommandsRuntime(runtime: TimerCommandsRuntime): void {
  timerCommandsRuntime.register(runtime);
}

const TICK_INTERVAL_MS = 15_000;

/**
 * Firing state is keyed by (timer id, channel) rather than timer id alone: a timer can now be
 * assigned to several streamers' channels, and each assigned channel fires independently, on its
 * own live/interval/message-count schedule — the same timer definition posting into two different
 * channels must not share one countdown.
 * @param row - The timer's config, joined with the channel this row is for.
 * @returns The composite `"{id}::{channel}"` key used as this row's `timerState` map key.
 */
function rowKey(row: { id: number; channel: string }): string {
  return `${row.id}::${row.channel}`;
}

const timerState = new Map<string, TimerRuntimeState>();

// ─── Shared Chat group cooldown ──────────────────────────────────────────────
//
// When several streamers' channels are merged into one Twitch Shared Chat session
// (multitwitch), each streamer's timer otherwise keeps firing on its own independent
// schedule — and since Shared Chat shows every participating channel's messages in
// one merged view, that stacks up and floods it. This caps how often ANY timer may
// post into a given session, and rotates fairly among the timers sharing it (see
// `pickRowsToFire`) so distinct messages take turns instead of one dominating.

const SHARED_SESSION_COOLDOWN_MS = 120_000;
const sessionLastFiredAt = new Map<string, number>();
const SESSION_COOLDOWN_ENTRY_MAX_AGE_MS = 10 * SHARED_SESSION_COOLDOWN_MS;

/** Drops session-cooldown entries older than {@link SESSION_COOLDOWN_ENTRY_MAX_AGE_MS} so the map doesn't grow unbounded as Shared Chat sessions come and go over long uptimes. */
function pruneStaleSessionCooldowns(now: number): void {
  for (const [sessionId, firedAt] of sessionLastFiredAt) {
    if (now - firedAt > SESSION_COOLDOWN_ENTRY_MAX_AGE_MS) sessionLastFiredAt.delete(sessionId);
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/**
 * Removes in-memory state for any (timer id, channel) pair no longer present in the latest
 * enabled-rows fetch.
 * @param currentKeys - {@link rowKey} values for every row in the latest enabled-rows fetch.
 * @returns Nothing — mutates the module-level `timerState` map (and the fire-gate's own
 *   block-reason log — see {@link pruneBlockReasonLog}) in place.
 */
function pruneStaleTimerState(currentKeys: ReadonlySet<string>): void {
  for (const key of timerState.keys()) {
    if (!currentKeys.has(key)) timerState.delete(key);
  }
  pruneBlockReasonLog(currentKeys);
}

/**
 * Resolves each of `channels`' current Twitch Shared Chat session id, in parallel, deduplicating
 * by underlying Twitch user id so a channel is only looked up once regardless of how many rows
 * reference it. A channel with no known user id, or whose session lookup fails/returns null, maps
 * to `null` (treated as "not currently in Shared Chat" by callers).
 * @param channels - Twitch channel logins to resolve.
 * @param loginUserIds - Map from channel login to Twitch user id.
 */
async function resolveSessionIdsByChannel(
  channels: readonly string[],
  loginUserIds: ReadonlyMap<string, string>,
): Promise<Map<string, string | null>> {
  const uniqueUserIds = [...new Set(channels.map((ch) => loginUserIds.get(ch)).filter((id): id is string => id !== undefined))];
  const resolved = await Promise.all(uniqueUserIds.map((uid) => resolveSharedChatSessionId(uid).catch(() => null)));
  const sessionIdByUserId = new Map(uniqueUserIds.map((uid, i) => [uid, resolved[i]]));

  const sessionIdByChannel = new Map<string, string | null>();
  for (const channel of channels) {
    const userId = loginUserIds.get(channel);
    sessionIdByChannel.set(channel, userId ? (sessionIdByUserId.get(userId) ?? null) : null);
  }
  return sessionIdByChannel;
}

/** A row picked to fire this tick, paired with the Shared Chat session (if any) it was picked for. */
interface PickedRow {
  row: TimerCommandForScheduler;
  sessionId: string | null;
}

/**
 * From the rows that already passed their own {@link evaluateFireBlock} check, decides which ones
 * actually get to fire this tick, applying the Shared Chat group cooldown: rows with no resolved
 * session always fire (unaffected — this is the fully-independent, outside-of-multitwitch case).
 * For rows sharing a session that's currently off cooldown, only the single row that has gone
 * longest without firing (oldest `lastFiredAt`) is picked, and the session is tentatively reserved
 * — this rotates fairly among the timers sharing a session (instead of one perpetually winning) and
 * prevents two rows in the same session both firing in one tick. The reservation is only
 * provisional: {@link sendTimerRow} releases it if the send doesn't actually succeed, so a failed
 * send can't silence the whole group for the full cooldown window. Rows in a session still on
 * cooldown, and rows not picked from an eligible session, are left untouched so they're
 * reconsidered on a later tick.
 * @param eligibleRows - Rows that already passed their own per-timer {@link evaluateFireBlock} check.
 * @param sessionIdByChannel - Each row's channel's resolved Shared Chat session id (or null).
 * @param now - Current time in epoch ms, shared across the whole tick.
 */
function pickRowsToFire(
  eligibleRows: readonly TimerCommandForScheduler[],
  sessionIdByChannel: ReadonlyMap<string, string | null>,
  now: number,
): PickedRow[] {
  const toFire: PickedRow[] = [];
  const bySession = new Map<string, TimerCommandForScheduler[]>();

  for (const row of eligibleRows) {
    const sessionId = sessionIdByChannel.get(row.channel) ?? null;
    if (!sessionId) {
      toFire.push({ row, sessionId: null });
      continue;
    }
    const group = bySession.get(sessionId);
    if (group) group.push(row); else bySession.set(sessionId, [row]);
  }

  for (const [sessionId, rows] of bySession) {
    const lastFired = sessionLastFiredAt.get(sessionId) ?? 0;
    if (now - lastFired < SHARED_SESSION_COOLDOWN_MS) continue;

    const picked = rows.reduce((oldest, row) => {
      const oldestState = timerState.get(rowKey(oldest))!;
      const rowState = timerState.get(rowKey(row))!;
      return rowState.lastFiredAt < oldestState.lastFiredAt ? row : oldest;
    });
    sessionLastFiredAt.set(sessionId, now); // provisional — released by sendTimerRow on failure
    toFire.push({ row: picked, sessionId });
  }

  return toFire;
}

/**
 * Posts one selected timer row to its channel and records the fire in the in-memory state.
 * No-ops if no runtime is registered. Never throws — a send failure is logged and swallowed so it
 * can't block other rows in the same tick. If `sessionId` is set and the send doesn't succeed (no
 * runtime, or `runtime.send` throws), releases that session's cooldown reservation made by
 * {@link pickRowsToFire} — guarded by a timestamp match so it can't clobber a newer reservation
 * made by another row in the same session on a later tick.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param now - Current time in epoch ms, shared across the whole tick.
 * @param sessionId - The Shared Chat session this row was provisionally reserved for, or null.
 */
async function sendTimerRow(row: TimerCommandForScheduler, now: number, sessionId: string | null): Promise<void> {
  const runtime = timerCommandsRuntime.get();
  if (!runtime) {
    if (sessionId && sessionLastFiredAt.get(sessionId) === now) sessionLastFiredAt.delete(sessionId);
    return;
  }

  const key = rowKey(row);
  const state = timerState.get(key)!;
  try {
    await runtime.send(row.channel, row.message);
    state.lastFiredAt = now;
    state.messagesAtLastFire = getMessageCount(row.channel);
    forgetBlockReason(key);
    log.info(`Posted timer ${row.id} to ${row.channel}`);
  } catch (err) {
    if (sessionId && sessionLastFiredAt.get(sessionId) === now) sessionLastFiredAt.delete(sessionId);
    log.error(`Failed to post timer command ${row.id} to ${row.channel}:`, err);
  }
}

/**
 * Runs one scheduler tick: fetches every enabled timer, prunes in-memory state for timers that no
 * longer exist/are disabled, seeds any newly-seen timer without firing it, then for the rest:
 * evaluates each row's own fire condition (logging via {@link logBlockReasonChange} when a row is
 * newly blocked on being offline or on chat activity, so a stuck gate is diagnosable from logs
 * instead of looking identical to a healthy row still waiting out its interval), resolves Shared
 * Chat sessions for the ones that are ready, picks which of those actually get to fire this tick
 * (applying the group cooldown — see {@link pickRowsToFire}), and sends the picked rows
 * concurrently via `Promise.allSettled` so one channel's send failure can't block another's.
 * No-ops (re-uses the in-flight promise) if a tick is already running.
 */
export async function runTimerCommandTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledTimerCommandsWithChannel();
      pruneStaleTimerState(new Set(rows.map(rowKey)));

      const now = Date.now();
      pruneStaleSessionCooldowns(now);

      const eligibleRows: TimerCommandForScheduler[] = [];
      for (const row of rows) {
        const key = rowKey(row);
        const state = timerState.get(key);
        if (!state) {
          timerState.set(key, { lastFiredAt: now, messagesAtLastFire: getMessageCount(row.channel) });
          continue;
        }
        const blockReason = evaluateFireBlock(row, state, now);
        logBlockReasonChange(key, row, blockReason, state);
        if (blockReason === null) eligibleRows.push(row);
      }

      const loginUserIds = timerCommandsRuntime.get()?.getLoginUserIds() ?? new Map<string, string>();
      const sessionIdByChannel = await resolveSessionIdsByChannel(eligibleRows.map((row) => row.channel), loginUserIds);
      const toFire = pickRowsToFire(eligibleRows, sessionIdByChannel, now);

      await Promise.allSettled(toFire.map(({ row, sessionId }) => sendTimerRow(row, now, sessionId)));
    } catch (err) {
      log.error('Failed to load enabled timer commands:', err);
    } finally {
      tickRunning = false;
    }
  })();
  return currentTickPromise;
}

/**
 * Starts the periodic timer-command tick. Call once at bot startup.
 * No-ops if already started, so a second call can't leak the original interval handle.
 */
export function startTimerCommandScheduler(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    runTimerCommandTick().catch((err) => log.error('Timer command tick error:', err));
  }, TICK_INTERVAL_MS);
  log.info(`Started — timer command tick every ${TICK_INTERVAL_MS / 1000}s`);
}

/** Stops the periodic timer-command tick and awaits any in-flight tick before returning. */
export async function stopTimerCommandScheduler(): Promise<void> {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  await currentTickPromise;
  timerState.clear();
  sessionLastFiredAt.clear();
  clearBlockReasonLog();
}
