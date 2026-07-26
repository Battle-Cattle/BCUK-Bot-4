import { createLogger } from '../../shared/logger';
import { getAllEnabledTimerCommandsWithChannel, type TimerCommandForScheduler } from '../../db';
import { getMessageCount } from '../twitchChatActivity';
import { isChannelLive } from '../monitor/twitchMonitor';
import { createRuntimeRegistry, type TwitchSendRuntime } from '../../commands/twitchRuntime';

const log = createLogger('TimerCommandScheduler');

// ─── Twitch runtime (registered from index.ts before startTwitchBot) ────────
//
// Same pattern as counterHandler.ts/shoutoutHandler.ts to avoid a circular
// import between twitchBot.ts and this scheduler.

const timerCommandsRuntime = createRuntimeRegistry<TwitchSendRuntime>();

/** Stores the Twitch chat runtime used to post timer messages. Call once from index.ts after the Twitch bot is ready. */
export function registerTimerCommandsRuntime(runtime: TwitchSendRuntime): void {
  timerCommandsRuntime.register(runtime);
}

const TICK_INTERVAL_MS = 15_000;

/** A timer's in-memory firing state — never persisted, so a restart simply restarts the countdown. */
interface TimerRuntimeState {
  lastFiredAt: number;
  messagesAtLastFire: number;
}

const timerState = new Map<number, TimerRuntimeState>();

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let currentTickPromise: Promise<void> = Promise.resolve();

/**
 * Decides whether a timer should fire right now, given its config and current in-memory state.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param state - The timer's current in-memory firing state.
 * @param now - Current time in epoch ms.
 */
function shouldFire(
  row: { interval_seconds: number; min_messages: number; require_live: boolean; channel: string },
  state: TimerRuntimeState,
  now: number,
): boolean {
  if (row.require_live && !isChannelLive(row.channel)) return false;
  if (now - state.lastFiredAt < row.interval_seconds * 1000) return false;
  if (row.min_messages > 0 && getMessageCount(row.channel) - state.messagesAtLastFire < row.min_messages) return false;
  return true;
}

/** Removes in-memory state for any timer id no longer present in the latest enabled-rows fetch. */
function pruneStaleTimerState(currentIds: ReadonlySet<number>): void {
  for (const id of timerState.keys()) {
    if (!currentIds.has(id)) timerState.delete(id);
  }
}

/**
 * Seeds in-memory state for a newly-seen timer without firing it (a restart or brand-new timer
 * waits one full interval before its first post), otherwise fires it via the registered runtime
 * if its conditions are satisfied. Never throws — a send failure is logged and swallowed so it
 * can't block other rows in the same tick.
 * @param row - The timer's config, joined with its Twitch channel.
 * @param now - Current time in epoch ms, shared across the whole tick.
 */
async function processTimerRow(row: TimerCommandForScheduler, now: number): Promise<void> {
  const state = timerState.get(row.id);
  if (!state) {
    timerState.set(row.id, { lastFiredAt: now, messagesAtLastFire: getMessageCount(row.channel) });
    return;
  }
  if (!shouldFire(row, state, now)) return;

  const runtime = timerCommandsRuntime.get();
  if (!runtime) return;

  try {
    await runtime.send(row.channel, row.message);
    state.lastFiredAt = now;
    state.messagesAtLastFire = getMessageCount(row.channel);
  } catch (err) {
    log.error(`Failed to post timer command ${row.id} to ${row.channel}:`, err);
  }
}

/**
 * Runs one scheduler tick: fetches every enabled timer, prunes in-memory state for timers that
 * no longer exist/are disabled, then processes each row (see {@link processTimerRow}) concurrently
 * via `Promise.allSettled` so one channel's send failure can't block another's. No-ops (re-uses
 * the in-flight promise) if a tick is already running.
 */
export async function runTimerCommandTick(): Promise<void> {
  if (tickRunning) return currentTickPromise;
  tickRunning = true;
  currentTickPromise = (async () => {
    try {
      const rows = await getAllEnabledTimerCommandsWithChannel();
      pruneStaleTimerState(new Set(rows.map((row) => row.id)));

      const now = Date.now();
      await Promise.allSettled(rows.map((row) => processTimerRow(row, now)));
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
}
