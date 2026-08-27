// Sibling to `statusStore.ts`: an in-memory, dependency-free store of live health/liveness
// signals for the bot's various components (Discord gateway, Twitch chat, DB, per-streamer
// EventSub connections, the Twitch stream monitor, and the schedulers), consumed by the owner
// health dashboard (`src/web/routes/health.ts`), the `!health` Discord command
// (`src/commands/healthCommandHandler.ts`), and the owner-alert watcher
// (`src/discord/ownerAlerts.ts`). Zero imports from `db`/`discord`/`web` — same rationale as
// `statusStore.ts` — so it can be imported from anywhere (including `shared/logger.ts`) without
// creating import cycles.

/**
 * How stale `monitor.lastPollAt` may get before a consumer should treat the Twitch stream
 * monitor as unhealthy. Set to 2x the monitor's own poll interval (60s, see
 * `src/twitch/monitor/twitchMonitor.ts`'s `POLL_INTERVAL_MS`) so a single slow/skipped poll
 * doesn't false-positive, but two in a row does.
 */
export const MONITOR_STALE_MS = 120_000;

/**
 * How stale a scheduler's `lastRunAt` may get before a consumer should treat it as unhealthy.
 * Set to 2x the slowest scheduler's own tick interval (the counter-archive scheduler polls
 * hourly — see `src/commands/counterScheduler.ts`'s `POLL_INTERVAL_MS` — the widest interval of
 * the three schedulers tracked here) so a single missed tick of any tracked scheduler doesn't
 * false-positive, but two in a row does.
 */
export const SCHEDULER_STALE_MS = 7_200_000;

/** Max number of entries kept in the error ring buffer (see {@link recordError}). Oldest evicted first. */
const MAX_ERRORS = 50;

/** One entry in the health store's bounded error ring buffer. */
export interface HealthErrorEntry {
  timestamp: Date;
  module: string;
  message: string;
}

/** Live connection/reconnect status for a single streamer's EventSub WebSocket connection. */
export interface EventSubHealth {
  connected: boolean;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  reconnectAttempts: number;
  lastError: string | null;
}

/** Live run status for one of the periodic schedulers. */
export interface SchedulerHealth {
  lastRunAt: Date | null;
  lastRunOk: boolean;
  lastError: string | null;
}

/** The set of scheduler names tracked by {@link recordSchedulerRun}. */
export type SchedulerName = 'counter' | 'rewardPricing' | 'timer';

/** Returns a fresh, disconnected/no-history EventSub health record. */
function defaultEventSubHealth(): EventSubHealth {
  return { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 0, lastError: null };
}

/** Returns a fresh, never-run scheduler health record. */
function defaultSchedulerHealth(): SchedulerHealth {
  return { lastRunAt: null, lastRunOk: true, lastError: null };
}

const state = {
  discordConnected: false,
  twitchChatConnected: false,
  db: {
    lastPingOk: true,
    lastPingAt: null as Date | null,
    lastError: null as string | null,
  },
  eventsub: new Map<string, EventSubHealth>(),
  monitor: {
    lastPollAt: null as Date | null,
    lastPollOk: true,
    lastError: null as string | null,
  },
  schedulers: new Map<SchedulerName, SchedulerHealth>(),
  errors: [] as HealthErrorEntry[],
};

// Registered by the web layer (via onHealthChanged) and by the owner-alert watcher, mirroring
// `statusStore.ts`'s `onStatusChanged` — a Set of listeners (not a single slot) since more than
// one consumer subscribes independently.
const healthChangeListeners = new Set<() => void>();

/**
 * Registers a callback invoked after every health mutation below, so the web layer and the
 * owner-alert watcher can react without this module depending on either of them. Adds to the
 * set of registered listeners — every registered listener is notified on each change; none are
 * dropped by a later registration.
 * @param listener - Called (with no arguments) after each health mutation.
 */
export function onHealthChanged(listener: () => void): void {
  healthChangeListeners.add(listener);
}

/** Invokes every registered health-change listener (see {@link onHealthChanged}). */
function notifyHealthChanged(): void {
  for (const listener of healthChangeListeners) listener();
}

/** Returns a guarded copy of an error message: `err.message` for an `Error`, `undefined` otherwise. */
function normalizeError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof Error ? error.message : String(error);
}

/** Records the Discord gateway client's connected/disconnected state. Notifies registered listeners. */
export function recordDiscordConnected(connected: boolean): void {
  state.discordConnected = connected;
  notifyHealthChanged();
}

/** Records the Twitch chat client's connected/disconnected state. Notifies registered listeners. */
export function recordTwitchChatConnected(connected: boolean): void {
  state.twitchChatConnected = connected;
  notifyHealthChanged();
}

/**
 * Records the outcome of a DB connectivity ping. Notifies registered listeners.
 * @param ok - Whether the ping succeeded.
 * @param error - Error message on failure; ignored (left as the previous value) when `ok` is true.
 */
export function recordDbPing(ok: boolean, error?: string): void {
  state.db.lastPingOk = ok;
  state.db.lastPingAt = new Date();
  if (!ok) state.db.lastError = error ?? state.db.lastError;
  notifyHealthChanged();
}

/**
 * Records a streamer's EventSub WebSocket connecting or disconnecting, creating its health
 * record on first use. On connect, resets `reconnectAttempts` to 0 and stamps
 * `lastConnectedAt`; on disconnect, stamps `lastDisconnectedAt`. Notifies registered listeners.
 * @param streamer - Streamer key (matches the name used elsewhere for this connection).
 * @param connected - New connected state.
 * @param error - Error message associated with a disconnect, if any.
 */
export function recordEventSubConnected(streamer: string, connected: boolean, error?: string): void {
  const existing = state.eventsub.get(streamer) ?? defaultEventSubHealth();
  existing.connected = connected;
  if (connected) {
    existing.reconnectAttempts = 0;
    existing.lastConnectedAt = new Date();
  } else {
    existing.lastDisconnectedAt = new Date();
    if (error !== undefined) existing.lastError = error;
  }
  state.eventsub.set(streamer, existing);
  notifyHealthChanged();
}

/**
 * Increments a streamer's EventSub reconnect-attempt counter, creating its health record on
 * first use. Notifies registered listeners.
 * @param streamer - Streamer key (matches the name used elsewhere for this connection).
 */
export function recordEventSubReconnectAttempt(streamer: string): void {
  const existing = state.eventsub.get(streamer) ?? defaultEventSubHealth();
  existing.reconnectAttempts += 1;
  state.eventsub.set(streamer, existing);
  notifyHealthChanged();
}

/**
 * Records the outcome of a Twitch stream-monitor poll. Notifies registered listeners.
 * @param ok - Whether the poll succeeded.
 * @param error - Error message on failure; ignored (left as the previous value) when `ok` is true.
 */
export function recordMonitorPoll(ok: boolean, error?: string): void {
  state.monitor.lastPollAt = new Date();
  state.monitor.lastPollOk = ok;
  if (!ok) state.monitor.lastError = error ?? state.monitor.lastError;
  notifyHealthChanged();
}

/**
 * Records the outcome of one scheduler's tick, creating its health record on first use.
 * Notifies registered listeners.
 * @param name - Which scheduler ran (see {@link SchedulerName}).
 * @param ok - Whether the tick succeeded.
 * @param error - Error message on failure; ignored (left as the previous value) when `ok` is true.
 */
export function recordSchedulerRun(name: SchedulerName, ok: boolean, error?: string): void {
  const existing = state.schedulers.get(name) ?? defaultSchedulerHealth();
  existing.lastRunAt = new Date();
  existing.lastRunOk = ok;
  if (!ok) existing.lastError = error ?? existing.lastError;
  state.schedulers.set(name, existing);
  notifyHealthChanged();
}

/**
 * Appends an error to the bounded ring buffer (see {@link MAX_ERRORS}), evicting the oldest
 * entry first once full. Notifies registered listeners. Intended primarily as the sink for
 * `shared/logger.ts`'s error-capturing transport, but usable directly too.
 * @param module - Log label identifying which module the error came from.
 * @param message - The error message.
 */
export function recordError(module: string, message: string): void {
  state.errors.push({ timestamp: new Date(), module, message });
  if (state.errors.length > MAX_ERRORS) state.errors.shift();
  notifyHealthChanged();
}

/** Plain-object snapshot shape returned by {@link getHealthSnapshot}. */
export interface HealthSnapshot {
  discordConnected: boolean;
  twitchChatConnected: boolean;
  db: { lastPingOk: boolean; lastPingAt: Date | null; lastError: string | null };
  eventsub: Record<string, EventSubHealth>;
  monitor: { lastPollAt: Date | null; lastPollOk: boolean; lastError: string | null };
  schedulers: Partial<Record<SchedulerName, SchedulerHealth>>;
  errors: HealthErrorEntry[];
}

/**
 * Returns a snapshot of the current health state: a deep-ish copy (own top-level objects
 * copied, Maps converted to plain records, the error list copied) so a caller mutating the
 * returned object can never affect internal state — same spirit as `statusStore.ts`'s
 * `getStatus()`.
 */
export function getHealthSnapshot(): HealthSnapshot {
  return {
    discordConnected: state.discordConnected,
    twitchChatConnected: state.twitchChatConnected,
    db: { ...state.db },
    eventsub: Object.fromEntries(
      Array.from(state.eventsub, ([key, value]) => [key, { ...value }]),
    ) as Record<string, EventSubHealth>,
    monitor: { ...state.monitor },
    schedulers: Object.fromEntries(
      Array.from(state.schedulers, ([key, value]) => [key, { ...value }]),
    ) as Partial<Record<SchedulerName, SchedulerHealth>>,
    errors: state.errors.map((e) => ({ ...e })),
  };
}

// `normalizeError` is exported for reuse by call sites that want to pass a caught `unknown`
// error straight into one of the `record*` functions above without duplicating this logic.
export { normalizeError };
