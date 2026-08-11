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

/** Picks whichever of `rows` has gone longest without firing (oldest `timerState.lastFiredAt`), breaking ties by keeping the first. */
function pickLongestWaiting(rows: readonly TimerCommandForScheduler[]): TimerCommandForScheduler {
  return rows.reduce((oldest, row) => {
    const oldestState = timerState.get(rowKey(oldest))!;
    const rowState = timerState.get(rowKey(row))!;
    return rowState.lastFiredAt < oldestState.lastFiredAt ? row : oldest;
  });
}

// ─── Per-command Shared Chat cooldown ────────────────────────────────────────
//
// When several of one timer's assigned streamers are merged into the same Twitch Shared Chat
// session (multitwitch), each of that timer's assigned channels otherwise keeps firing on its own
// independent schedule — and since Shared Chat shows every participating channel's messages in one
// merged view, that stacks up into the same command posting several times in a few minutes. This
// caps a given timer to firing at most once per its own `interval_seconds` into a given session —
// as if that whole session were one channel, for this command specifically — and rotates fairly
// among the timer's channels sharing it (see `pickRowsToFire`) so each gets a turn instead of one
// dominating. Scoped per (timer id, session id): a *different* timer assigned to the same
// shared-chat streamers gets its own independent cooldown, sized to its own interval, and never
// competes with this one for a turn.

interface CommandSessionCooldown {
  firedAt: number;
  /** The interval (ms) that was actually applied when this cooldown was reserved — needed to prune it correctly later, since different timers (and a live-edited interval) can each imply a different cooldown length. */
  cooldownMs: number;
}

const commandSessionLastFiredAt = new Map<string, CommandSessionCooldown>();

/** Composite key for {@link commandSessionLastFiredAt}: one cooldown per (timer, Shared Chat session). */
function commandSessionKey(timerId: number, sessionId: string): string {
  return `${timerId}::${sessionId}`;
}

/** A stale command-session cooldown entry is kept around for this many multiples of its own cooldown length before being pruned, so the map doesn't grow unbounded as Shared Chat sessions come and go over long uptimes. */
const COMMAND_SESSION_COOLDOWN_PRUNE_FACTOR = 10;

/** Drops command-session cooldown entries old enough (relative to their own recorded cooldown length) that the session or assignment behind them is almost certainly gone. */
function pruneStaleCommandSessionCooldowns(now: number): void {
  for (const [key, entry] of commandSessionLastFiredAt) {
    if (now - entry.firedAt > entry.cooldownMs * COMMAND_SESSION_COOLDOWN_PRUNE_FACTOR) {
      commandSessionLastFiredAt.delete(key);
    }
  }
}

// ─── Cross-command channel floor ─────────────────────────────────────────────
//
// Independent of Shared Chat: if a single Twitch channel has several *different* timer commands
// assigned to it, each fires on its own schedule with nothing otherwise stopping two of them from
// landing seconds apart. This enforces a minimum gap between any two *different* commands posting
// into the same channel, and — like the Shared Chat cooldown above — lets whichever has waited
// longest go first. It deliberately does not slow down a single command's own cadence: the floor
// only applies when the channel's last post came from a *different* timer than the one about to
// post now, so a lone timer with a short interval (as low as `chk_timer_command_interval`'s 60s
// floor) is never throttled below its own configured interval just for being alone on its channel.

const CHANNEL_MIN_SPACING_MS = 120_000;

interface ChannelCooldown {
  firedAt: number;
  timerId: number;
}

const channelLastFiredAt = new Map<string, ChannelCooldown>();

const CHANNEL_MIN_SPACING_PRUNE_MS = 10 * CHANNEL_MIN_SPACING_MS;

/** Drops channel-floor entries older than {@link CHANNEL_MIN_SPACING_PRUNE_MS} so the map doesn't grow unbounded as channels stop being assigned any timer over long uptimes. */
function pruneStaleChannelCooldowns(now: number): void {
  for (const [channel, entry] of channelLastFiredAt) {
    if (now - entry.firedAt > CHANNEL_MIN_SPACING_PRUNE_MS) channelLastFiredAt.delete(channel);
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

/** A row picked to fire this tick, paired with the reservations {@link sendTimerRow} must release if the send doesn't succeed. */
interface PickedRow {
  row: TimerCommandForScheduler;
  /** The {@link commandSessionKey} reserved for this pick, or null if its channel isn't in a Shared Chat session. */
  sessionKey: string | null;
}

/**
 * From the rows that already passed their own {@link evaluateFireBlock} check, decides which ones
 * actually get to fire this tick, in two layers:
 *
 * 1. Per-command Shared Chat cooldown: groups rows by (timer id, Shared Chat session), and for a
 *    group off its own cooldown (sized to that timer's `interval_seconds`), picks the row that's
 *    gone longest without firing and reserves the cooldown. Rows whose channel isn't in a session
 *    pass straight through. See the module doc above `commandSessionLastFiredAt`.
 * 2. Cross-command channel floor: groups whatever survived layer 1 by channel, and for a channel
 *    whose last post came from a *different* timer than the longest-waiting candidate here, within
 *    {@link CHANNEL_MIN_SPACING_MS}, defers it to a later tick. See the module doc above
 *    `channelLastFiredAt`.
 *
 * Both reservations are only provisional: {@link sendTimerRow} releases them if the send doesn't
 * actually succeed, so a failed send can't silence a session/channel for the full cooldown window.
 * Rows not picked at either layer are left untouched so they're reconsidered on a later tick.
 * @param eligibleRows - Rows that already passed their own per-timer {@link evaluateFireBlock} check.
 * @param sessionIdByChannel - Each row's channel's resolved Shared Chat session id (or null).
 * @param now - Current time in epoch ms, shared across the whole tick.
 */
function pickRowsToFire(
  eligibleRows: readonly TimerCommandForScheduler[],
  sessionIdByChannel: ReadonlyMap<string, string | null>,
  now: number,
): PickedRow[] {
  // Layer 1 — per-command Shared Chat cooldown.
  const layer1Survivors: PickedRow[] = [];
  const bySessionAndTimer = new Map<string, TimerCommandForScheduler[]>();

  for (const row of eligibleRows) {
    const sessionId = sessionIdByChannel.get(row.channel) ?? null;
    if (!sessionId) {
      layer1Survivors.push({ row, sessionKey: null });
      continue;
    }
    const key = commandSessionKey(row.id, sessionId);
    const group = bySessionAndTimer.get(key);
    if (group) group.push(row); else bySessionAndTimer.set(key, [row]);
  }

  for (const [key, rows] of bySessionAndTimer) {
    const cooldownMs = rows[0].interval_seconds * 1000;
    const entry = commandSessionLastFiredAt.get(key);
    if (entry && now - entry.firedAt < cooldownMs) continue;

    const picked = pickLongestWaiting(rows);
    commandSessionLastFiredAt.set(key, { firedAt: now, cooldownMs }); // provisional — released by sendTimerRow on failure
    layer1Survivors.push({ row: picked, sessionKey: key });
  }

  // Layer 2 — cross-command channel floor, applied regardless of Shared Chat status.
  const toFire: PickedRow[] = [];
  const byChannel = new Map<string, PickedRow[]>();
  for (const picked of layer1Survivors) {
    const group = byChannel.get(picked.row.channel);
    if (group) group.push(picked); else byChannel.set(picked.row.channel, [picked]);
  }

  for (const [channel, picks] of byChannel) {
    const candidate = pickLongestWaiting(picks.map((p) => p.row));
    const candidatePick = picks.find((p) => p.row === candidate)!;

    const lastPoster = channelLastFiredAt.get(channel);
    if (lastPoster && lastPoster.timerId !== candidate.id && now - lastPoster.firedAt < CHANNEL_MIN_SPACING_MS) continue;

    channelLastFiredAt.set(channel, { firedAt: now, timerId: candidate.id }); // provisional — released by sendTimerRow on failure
    toFire.push(candidatePick);
  }

  return toFire;
}

/**
 * Releases the provisional cooldown reservations {@link pickRowsToFire} made for a row, if the send
 * that would have justified them didn't actually happen (no runtime, or `runtime.send` threw).
 * Guarded by matching the reservation's own identity so a release can't clobber a newer reservation
 * made by a different row on a later tick.
 * @param sessionKey - The command-session cooldown key reserved for this row, or null.
 * @param channel - The row's Twitch channel — the channel-floor reservation to potentially release.
 * @param timerId - The row's timer id — must match the channel-floor reservation's own recorded id.
 * @param now - The epoch-ms timestamp the reservations were made under, shared across the whole tick.
 * @returns Nothing — mutates the module-level cooldown maps in place.
 */
function releaseReservations(sessionKey: string | null, channel: string, timerId: number, now: number): void {
  if (sessionKey) {
    const entry = commandSessionLastFiredAt.get(sessionKey);
    if (entry && entry.firedAt === now) commandSessionLastFiredAt.delete(sessionKey);
  }
  const channelEntry = channelLastFiredAt.get(channel);
  if (channelEntry && channelEntry.firedAt === now && channelEntry.timerId === timerId) {
    channelLastFiredAt.delete(channel);
  }
}

/**
 * Posts one selected timer row to its channel and records the fire in the in-memory state.
 * No-ops if no runtime is registered. Never throws — a send failure is logged and swallowed so it
 * can't block other rows in the same tick. If the send doesn't succeed (no runtime, or
 * `runtime.send` throws), releases the cooldown reservation(s) {@link pickRowsToFire} made for this
 * row — see {@link releaseReservations}.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param now - Current time in epoch ms, shared across the whole tick.
 * @param sessionKey - The command-session cooldown key this row was provisionally reserved for, or null.
 */
async function sendTimerRow(row: TimerCommandForScheduler, now: number, sessionKey: string | null): Promise<void> {
  const runtime = timerCommandsRuntime.get();
  if (!runtime) {
    releaseReservations(sessionKey, row.channel, row.id, now);
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
    releaseReservations(sessionKey, row.channel, row.id, now);
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
 * (applying the per-command Shared Chat cooldown and the cross-command channel floor — see
 * {@link pickRowsToFire}), and sends the picked rows concurrently via `Promise.allSettled` so one
 * channel's send failure can't block another's. No-ops (re-uses the in-flight promise) if a tick
 * is already running.
 */
export async function runTimerCommandTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledTimerCommandsWithChannel();
      pruneStaleTimerState(new Set(rows.map(rowKey)));

      const now = Date.now();
      pruneStaleCommandSessionCooldowns(now);
      pruneStaleChannelCooldowns(now);

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

      await Promise.allSettled(toFire.map(({ row, sessionKey }) => sendTimerRow(row, now, sessionKey)));
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
  commandSessionLastFiredAt.clear();
  channelLastFiredAt.clear();
  clearBlockReasonLog();
}
