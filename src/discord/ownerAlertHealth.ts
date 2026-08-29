import { MONITOR_STALE_MS, SCHEDULER_STALE_MS, type HealthSnapshot } from '../shared/healthStore';

/** One component's derived ok/fail state, plus an error message when it's failing. */
export type ComponentOk = { ok: boolean; error: string | null };

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
 * Resolves the current ok/fail boolean and an optional error string for every component
 * `ownerAlerts.ts`'s watcher tracks, from a health snapshot and the staleness constants. One
 * entry per Discord/Twitch-chat/DB/EventSub-streamer/monitor/scheduler component, keyed by a
 * stable component id used across ticks to track edge transitions.
 * @param snapshot - The health snapshot to derive component states from.
 * @returns A map from component id to `{ ok, error }`.
 */
export function deriveComponentOks(snapshot: HealthSnapshot): Map<string, ComponentOk> {
  const result = new Map<string, ComponentOk>();
  addConnectivityOks(snapshot, result);
  addEventSubOks(snapshot, result);
  addMonitorOk(snapshot, result);
  addSchedulerOks(snapshot, result);
  return result;
}
