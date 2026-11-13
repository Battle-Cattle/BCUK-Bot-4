/**
 * How many entries an in-memory timestamp map (cooldowns, notice throttles) may hold before a
 * write sweeps out the stale ones. Below it nothing is swept, so small maps cost nothing extra.
 */
export const TIMESTAMP_MAP_SWEEP_THRESHOLD = 1000;

/**
 * Deletes the entries whose timestamp is at least `maxAgeMs` old, once `map` has grown past
 * {@link TIMESTAMP_MAP_SWEEP_THRESHOLD}. The cooldown and notice stores add an entry per viewer
 * and never need one after its window has passed, so without this they grow by one entry for
 * every distinct chatter over a long uptime (#1005).
 * @param map - Key → epoch-millisecond timestamp of the last claim.
 * @param maxAgeMs - Entries at least this old can no longer affect anything.
 * @param now - Current time in epoch milliseconds.
 */
export function pruneOlderThan(map: Map<string, number>, maxAgeMs: number, now: number): void {
  if (map.size <= TIMESTAMP_MAP_SWEEP_THRESHOLD) return;
  for (const [key, at] of map) {
    if (now - at >= maxAgeMs) map.delete(key);
  }
}
