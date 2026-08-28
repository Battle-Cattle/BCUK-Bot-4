import { createLogger } from '../shared/logger';
import { createRuntimeRegistry } from '../commands/twitchRuntime';
import { findOwnerUser } from '../db';
import { getHealthSnapshot, onHealthChanged, MONITOR_STALE_MS, SCHEDULER_STALE_MS, type HealthSnapshot } from '../shared/healthStore';

const log = createLogger('OwnerAlerts');

/** Runtime hook injected from `index.ts`, mirroring every other `registerXRuntime` pattern in this codebase (see `twitchRuntime.ts`'s `createRuntimeRegistry`) — avoids a circular import back into `index.ts`/`discordBot.ts`. */
interface OwnerAlertRuntime {
  send: (discordId: string, message: string) => Promise<void>;
}

const runtimeRegistry = createRuntimeRegistry<OwnerAlertRuntime>();

/**
 * Registers the runtime used to DM the bot owner. Call once from `index.ts` after the
 * Discord bot is ready.
 * @param runtime - The {@link OwnerAlertRuntime} to store.
 */
export function registerOwnerAlertRuntime(runtime: OwnerAlertRuntime): void {
  runtimeRegistry.register(runtime);
}

/** How long a component may keep re-alerting while it stays in the failing state, before this watcher sends another notification. */
const REALERT_COOLDOWN_MS = 30 * 60_000;

/** Per-component edge-trigger state tracked across health-changed notifications. */
interface ComponentAlertState {
  failing: boolean;
  lastAlertAt: number;
}

const componentStates = new Map<string, ComponentAlertState>();

/**
 * Caches the last successfully resolved owner Discord ID, so a `findOwnerUser()` failure (e.g.
 * the DB itself being down — the very case this watcher most needs to alert about) doesn't also
 * prevent the alert from being sent. Cleared to `null` whenever a successful lookup confirms
 * there's no owner row (rather than left stale) — see {@link resolveOwnerDiscordId}.
 */
let cachedOwnerDiscordId: string | null = null;

let watcherStarted = false;

/** One component's derived ok/fail state, plus an error message when it's failing. */
type ComponentOk = { ok: boolean; error: string | null };

/** Sets the `discord`/`twitchChat`/`db` connectivity entries into `result`. */
function addConnectivityOks(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  result.set('discord', { ok: snapshot.discordConnected, error: snapshot.discordConnected ? null : 'Discord gateway disconnected' });
  result.set('twitchChat', { ok: snapshot.twitchChatConnected, error: snapshot.twitchChatConnected ? null : 'Twitch chat disconnected' });
  result.set('db', { ok: snapshot.db.lastPingOk, error: snapshot.db.lastPingOk ? null : (snapshot.db.lastError ?? 'DB ping failed') });
}

/** Sets one `eventsub:<streamer>` entry per tracked streamer into `result`. */
function addEventSubOks(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  for (const [streamer, health] of Object.entries(snapshot.eventsub)) {
    result.set(`eventsub:${streamer}`, {
      ok: health.connected,
      error: health.connected ? null : (health.lastError ?? `EventSub disconnected for ${streamer}`),
    });
  }
}

/** Sets the `monitor` entry into `result`, treating a poll older than {@link MONITOR_STALE_MS} as failing too. */
function addMonitorOk(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  const now = Date.now();
  const stale = snapshot.monitor.lastPollAt !== null && now - snapshot.monitor.lastPollAt.getTime() > MONITOR_STALE_MS;
  const ok = snapshot.monitor.lastPollOk && !stale;
  result.set('monitor', {
    ok,
    error: ok ? null : (snapshot.monitor.lastError ?? (stale ? 'Stream monitor poll is stale' : 'Stream monitor poll failed')),
  });
}

/** Sets one `scheduler:<name>` entry per tracked scheduler into `result`, treating a run older than {@link SCHEDULER_STALE_MS} as failing too. */
function addSchedulerOks(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  const now = Date.now();
  for (const [name, health] of Object.entries(snapshot.schedulers)) {
    if (!health) continue;
    const stale = health.lastRunAt !== null && now - health.lastRunAt.getTime() > SCHEDULER_STALE_MS;
    const ok = health.lastRunOk && !stale;
    result.set(`scheduler:${name}`, {
      ok,
      error: ok ? null : (health.lastError ?? (stale ? `${name} scheduler run is stale` : `${name} scheduler run failed`)),
    });
  }
}

/**
 * Resolves the current ok/fail boolean and an optional error string for every component this
 * watcher tracks, from a health snapshot and the staleness constants. One entry per
 * Discord/Twitch-chat/DB/EventSub-streamer/monitor/scheduler component, keyed by a stable
 * component id used across ticks to track edge transitions.
 * @param snapshot - The health snapshot to derive component states from.
 * @returns A map from component id to `{ ok, error }`.
 */
function deriveComponentOks(snapshot: HealthSnapshot): Map<string, ComponentOk> {
  const result = new Map<string, ComponentOk>();
  addConnectivityOks(snapshot, result);
  addEventSubOks(snapshot, result);
  addMonitorOk(snapshot, result);
  addSchedulerOks(snapshot, result);
  return result;
}

/**
 * Resolves the Discord ID to DM: a fresh `findOwnerUser()` lookup when it succeeds (also
 * refreshing {@link cachedOwnerDiscordId}), falling back to the last cached ID only if the
 * lookup itself throws (e.g. the DB is down — exactly the case this watcher needs to still be
 * able to alert about). A successful lookup that finds no owner row is authoritative — it clears
 * the cache and returns null, rather than falling back to a possibly-stale cached ID for an
 * owner that may have just been removed. Returns null (and logs) if there's no cached ID yet to
 * fall back to on a failed lookup.
 */
async function resolveOwnerDiscordId(): Promise<string | null> {
  try {
    const owner = await findOwnerUser();
    if (owner) {
      cachedOwnerDiscordId = owner.discord_id;
      return owner.discord_id;
    }
    cachedOwnerDiscordId = null;
    return null;
  } catch (err) {
    log.error('Failed to resolve owner user — falling back to cached ID if any:', err);
    if (!cachedOwnerDiscordId) {
      log.warn('No cached owner ID available — skipping alert.');
      return null;
    }
    return cachedOwnerDiscordId;
  }
}

/**
 * Sends a DM alert to the bot owner via the registered runtime. Never throws — a failed DM is
 * logged and swallowed so it can never crash the process (see {@link registerOwnerAlertRuntime}).
 * @param message - The alert text to send.
 */
async function sendOwnerAlert(message: string): Promise<void> {
  const runtime = runtimeRegistry.get();
  if (!runtime) {
    log.warn('No owner-alert runtime registered — skipping alert:', message);
    return;
  }
  const discordId = await resolveOwnerDiscordId();
  if (!discordId) return;
  try {
    await runtime.send(discordId, message);
  } catch (err) {
    log.error('Failed to send owner alert DM:', err);
  }
}

/**
 * Reacts to one health-changed notification: derives every tracked component's ok/fail state
 * from the latest snapshot, and for each one whose state transitioned since the last check —
 * or that's still failing after the {@link REALERT_COOLDOWN_MS} cooldown has elapsed — sends an
 * edge-triggered DM alert to the owner. A component seen for the first time is only recorded
 * (not alerted on) if it starts out healthy, matching the "nothing was wrong before" baseline.
 */
function handleHealthChanged(): void {
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);
  const now = Date.now();

  for (const [componentId, { ok, error }] of componentOks) {
    const existing = componentStates.get(componentId);

    if (!existing) {
      componentStates.set(componentId, { failing: !ok, lastAlertAt: ok ? 0 : now });
      if (!ok) {
        void sendOwnerAlert(`🔴 ${componentId} is down: ${error ?? 'unknown error'}`);
      }
      continue;
    }

    if (ok && existing.failing) {
      existing.failing = false;
      existing.lastAlertAt = now;
      void sendOwnerAlert(`✅ ${componentId} recovered`);
    } else if (!ok && !existing.failing) {
      existing.failing = true;
      existing.lastAlertAt = now;
      void sendOwnerAlert(`🔴 ${componentId} is down: ${error ?? 'unknown error'}`);
    } else if (!ok && existing.failing && now - existing.lastAlertAt > REALERT_COOLDOWN_MS) {
      existing.lastAlertAt = now;
      void sendOwnerAlert(`🔴 ${componentId} is still down: ${error ?? 'unknown error'}`);
    }
  }
}

/**
 * Seeds this watcher's baseline component state and owner-ID cache from the current health
 * snapshot, without sending any alerts. Call once from `index.ts`, after
 * {@link registerOwnerAlertRuntime} and before {@link startOwnerAlertWatcher} — otherwise the
 * watcher's first health-changed notification would compare against an empty baseline and fire
 * false "down" alerts for components still mid-startup (e.g. Twitch chat, before
 * `startTwitchBot()` has run). Also resolves and caches the owner's Discord ID up front (via
 * {@link resolveOwnerDiscordId}) so the very first real failure — e.g. a DB outage — doesn't skip
 * its alert because `cachedOwnerDiscordId` was never populated yet.
 */
export async function primeOwnerAlertBaseline(): Promise<void> {
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);
  const now = Date.now();
  for (const [componentId, { ok }] of componentOks) {
    componentStates.set(componentId, { failing: !ok, lastAlertAt: now });
  }
  await resolveOwnerDiscordId();
}

/**
 * Subscribes to `healthStore.onHealthChanged` and starts sending owner DM alerts on
 * component health transitions. Call once from `index.ts`, after {@link primeOwnerAlertBaseline}.
 * Idempotent — a second call is a no-op, so it can never register a duplicate listener.
 */
export function startOwnerAlertWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  onHealthChanged(handleHealthChanged);
}

/** Test-only: resets all module state so each test starts from a clean slate. */
export function __resetOwnerAlertsForTests(): void {
  componentStates.clear();
  cachedOwnerDiscordId = null;
  watcherStarted = false;
}
