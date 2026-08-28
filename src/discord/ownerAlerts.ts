import { createLogger } from '../shared/logger';
import { createRuntimeRegistry } from '../commands/twitchRuntime';
import { findOwnerUser } from '../db';
import { getHealthSnapshot, onHealthChanged, MONITOR_STALE_MS, SCHEDULER_STALE_MS, type HealthSnapshot } from '../shared/healthStore';

const log = createLogger('OwnerAlerts');

/** Runtime hook injected from `index.ts`, mirroring every other `registerXRuntime` pattern in this codebase (see `twitchRuntime.ts`'s `createRuntimeRegistry`) — avoids a circular import back into `index.ts`/`discordBot.ts`. */
interface OwnerAlertRuntime {
  /**
   * Sends `message` to the bot owner as a Discord DM.
   * @param discordId - The owner's Discord user id to DM.
   * @param message - The alert text to send.
   * @returns Resolves once the DM has been sent; rejects if delivery fails.
   */
  send: (discordId: string, message: string) => Promise<void>;
}

const runtimeRegistry = createRuntimeRegistry<OwnerAlertRuntime>();

/**
 * Registers the runtime used to DM the bot owner. Call once from `index.ts` after the
 * Discord bot is ready.
 * @param runtime - The {@link OwnerAlertRuntime} to store.
 * @returns void.
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
  /**
   * Whether a "down" DM has actually been sent for the current failure. A component seeded as
   * failing at startup (e.g. `twitchChat`, before `startTwitchBot()` has run — see
   * {@link primeOwnerAlertBaseline}) starts with this false, so its eventual recovery doesn't fire
   * a "recovered" DM with no matching prior "down" DM.
   */
  downAlertSent: boolean;
  /**
   * Bumped on every failing-episode boundary — a fresh ok→fail transition (or first seen already
   * failing), and a fail→ok recovery. Lets {@link dispatchDownAlert}'s delayed delivery result
   * detect that the component has since moved past the episode it was sent for (recovered, or
   * recovered and failed again) and skip marking {@link downAlertSent} for one that's no longer
   * current.
   */
  generation: number;
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

/**
 * Sets the `discord`/`twitchChat`/`db` connectivity entries into `result`.
 * @param snapshot - The health snapshot to read connectivity state from.
 * @param result - The map to add entries to, mutated in place.
 * @returns void.
 */
function addConnectivityOks(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  result.set('discord', { ok: snapshot.discordConnected, error: snapshot.discordConnected ? null : 'Discord gateway disconnected' });
  result.set('twitchChat', { ok: snapshot.twitchChatConnected, error: snapshot.twitchChatConnected ? null : 'Twitch chat disconnected' });
  result.set('db', { ok: snapshot.db.lastPingOk, error: snapshot.db.lastPingOk ? null : (snapshot.db.lastError ?? 'DB ping failed') });
}

/**
 * Sets one `eventsub:<streamer>` entry per tracked streamer into `result`.
 * @param snapshot - The health snapshot to read EventSub state from.
 * @param result - The map to add entries to, mutated in place.
 * @returns void.
 */
function addEventSubOks(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  for (const [streamer, health] of Object.entries(snapshot.eventsub)) {
    result.set(`eventsub:${streamer}`, {
      ok: health.connected,
      error: health.connected ? null : (health.lastError ?? `EventSub disconnected for ${streamer}`),
    });
  }
}

/**
 * Sets the `monitor` entry into `result`, treating a poll older than {@link MONITOR_STALE_MS} as failing too.
 * @param snapshot - The health snapshot to read monitor state from.
 * @param result - The map to add the entry to, mutated in place.
 * @returns void.
 */
function addMonitorOk(snapshot: HealthSnapshot, result: Map<string, ComponentOk>): void {
  const now = Date.now();
  const stale = snapshot.monitor.lastPollAt !== null && now - snapshot.monitor.lastPollAt.getTime() > MONITOR_STALE_MS;
  const ok = snapshot.monitor.lastPollOk && !stale;
  result.set('monitor', {
    ok,
    error: ok ? null : (snapshot.monitor.lastError ?? (stale ? 'Stream monitor poll is stale' : 'Stream monitor poll failed')),
  });
}

/**
 * Sets one `scheduler:<name>` entry per tracked scheduler into `result`, treating a run older than {@link SCHEDULER_STALE_MS} as failing too.
 * @param snapshot - The health snapshot to read scheduler state from.
 * @param result - The map to add entries to, mutated in place.
 * @returns void.
 */
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
 * @returns The Discord id to DM, or null if none is available.
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
 * @returns Whether the DM was actually delivered — false if no runtime is registered, the owner
 *   ID couldn't be resolved, or the send itself failed.
 */
async function sendOwnerAlert(message: string): Promise<boolean> {
  const runtime = runtimeRegistry.get();
  if (!runtime) {
    log.warn('No owner-alert runtime registered — skipping alert:', message);
    return false;
  }
  const discordId = await resolveOwnerDiscordId();
  if (!discordId) return false;
  try {
    await runtime.send(discordId, message);
    return true;
  } catch (err) {
    log.error('Failed to send owner alert DM:', err);
    return false;
  }
}

/**
 * Sends a "down" (or, for a cooldown re-notification, "still down") DM for a component and, only
 * once delivery is confirmed, marks {@link ComponentAlertState.downAlertSent} — so a component
 * whose down DM never reached the owner (no runtime, owner lookup failure, or a rejected send)
 * doesn't later fire a false "recovered" DM. Guards against a delayed delivery result from an
 * earlier failure episode incorrectly marking a newer one, via {@link ComponentAlertState.generation}.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param error - The component's current error message, if any.
 * @param state - The component's tracked alert state, mutated in place once delivery resolves.
 * @param stillDown - Whether this is a cooldown re-notification for an already-failing component,
 *   rather than the initial down transition.
 * @returns void — the alert send and any resulting state update happen asynchronously.
 */
function dispatchDownAlert(componentId: string, error: string | null, state: ComponentAlertState, stillDown: boolean): void {
  const generation = state.generation;
  const label = stillDown ? 'is still down' : 'is down';
  void sendOwnerAlert(`🔴 ${componentId} ${label}: ${error ?? 'unknown error'}`).then((delivered) => {
    if (delivered && state.generation === generation) {
      state.downAlertSent = true;
    }
  });
}

/**
 * Records a component seen for the first time: stored (not alerted on) if it starts out healthy,
 * matching the "nothing was wrong before" baseline, or alerted immediately if it starts out
 * failing.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param ok - Whether the component is currently healthy.
 * @param error - The component's current error message, if failing.
 * @returns void.
 */
function handleFirstSeenComponent(componentId: string, ok: boolean, error: string | null): void {
  const now = Date.now();
  const state: ComponentAlertState = { failing: !ok, lastAlertAt: ok ? 0 : now, downAlertSent: false, generation: 0 };
  componentStates.set(componentId, state);
  if (!ok) {
    dispatchDownAlert(componentId, error, state, false);
  }
}

/**
 * Reacts to one component's latest ok/fail state against its previously tracked state: sends an
 * edge-triggered DM alert on a fail→ok or ok→fail transition, or a "still down" DM once the
 * {@link REALERT_COOLDOWN_MS} cooldown has elapsed for a component that's stayed failing.
 * @param componentId - The component's stable id (see {@link deriveComponentOks}).
 * @param ok - Whether the component is currently healthy.
 * @param error - The component's current error message, if failing.
 * @param existing - The component's previously tracked alert state, mutated in place.
 * @returns void.
 */
function handleTrackedComponent(componentId: string, ok: boolean, error: string | null, existing: ComponentAlertState): void {
  const now = Date.now();

  if (ok && existing.failing) {
    existing.failing = false;
    existing.lastAlertAt = now;
    // Only announce a recovery if a "down" DM was actually delivered for this failure — otherwise
    // this is a component that was merely seeded as failing at startup (e.g. twitchChat, before
    // startTwitchBot() has run), or whose down DM never reached the owner, finishing its normal
    // startup rather than undergoing a real recovery.
    const wasAlerted = existing.downAlertSent;
    existing.downAlertSent = false;
    // Bump the generation so a still-in-flight down-DM delivery from this now-ended episode can't
    // resurrect downAlertSent (via dispatchDownAlert's delayed .then()) after this recovery.
    existing.generation += 1;
    if (wasAlerted) {
      void sendOwnerAlert(`✅ ${componentId} recovered`);
    }
  } else if (!ok && !existing.failing) {
    existing.failing = true;
    existing.lastAlertAt = now;
    existing.downAlertSent = false;
    existing.generation += 1;
    dispatchDownAlert(componentId, error, existing, false);
  } else if (!ok && existing.failing && now - existing.lastAlertAt > REALERT_COOLDOWN_MS) {
    existing.lastAlertAt = now;
    dispatchDownAlert(componentId, error, existing, true);
  }
}

/**
 * Reacts to one health-changed notification: derives every tracked component's ok/fail state
 * from the latest snapshot and dispatches each one to {@link handleFirstSeenComponent} or
 * {@link handleTrackedComponent} depending on whether it's been seen before.
 * @returns void.
 */
function handleHealthChanged(): void {
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);

  for (const [componentId, { ok, error }] of componentOks) {
    const existing = componentStates.get(componentId);
    if (existing) {
      handleTrackedComponent(componentId, ok, error, existing);
    } else {
      handleFirstSeenComponent(componentId, ok, error);
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
 * Resolves the owner ID *before* taking the health snapshot — the watcher isn't listening yet
 * at this point, so nothing here reacts to concurrent health changes, but a snapshot taken
 * before that await could still go stale (e.g. Discord finishing its connect) by the time this
 * function returns and the caller starts the watcher, seeding a baseline that's already wrong.
 * @returns Resolves once both owner-ID resolution and baseline seeding have completed.
 */
export async function primeOwnerAlertBaseline(): Promise<void> {
  await resolveOwnerDiscordId();
  const snapshot = getHealthSnapshot();
  const componentOks = deriveComponentOks(snapshot);
  const now = Date.now();
  for (const [componentId, { ok }] of componentOks) {
    // downAlertSent starts false even for a component seeded as already-failing (e.g. twitchChat,
    // before startTwitchBot() has run) — no "down" DM was actually sent for this baseline state,
    // so its later recovery must not fire a "recovered" DM either. See handleHealthChanged.
    componentStates.set(componentId, { failing: !ok, lastAlertAt: now, downAlertSent: false, generation: 0 });
  }
}

/**
 * Subscribes to `healthStore.onHealthChanged` and starts sending owner DM alerts on
 * component health transitions. Call once from `index.ts`, after {@link primeOwnerAlertBaseline}.
 * Idempotent — a second call is a no-op, so it can never register a duplicate listener.
 * @returns void.
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
