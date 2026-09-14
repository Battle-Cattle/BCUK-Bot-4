import {
  createManagedLookupCache,
  registerFirstWinsWithWarning,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { normalizeCommandList, normalizeCommand } from './commandStringUtils';
import { isAnyCommandTakenAcrossTables } from './commandLocks';
import { getAllCounters, type DbCounter, type DbMatchedCounter, type CounterMatchType } from './counters';

// ─── Cache interface ──────────────────────────────────────────────────────────

interface CounterLookupCache extends RefreshingLookupCache {
  byCommand: Map<string, DbMatchedCounter>;
}

// ─── Cache builder ────────────────────────────────────────────────────────────

/**
 * Creates an empty, already-stale counter lookup cache used as the initial/fallback state
 * before the first successful refresh.
 * @returns An empty `CounterLookupCache` with `loadedAt` set to 0.
 */
function createEmptyCounterLookupCache(): CounterLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byCommand: new Map<string, DbMatchedCounter>(),
  };
}

/** Builds this cache's composite key: counters are per-guild, so the same command string in two
 *  different guilds must never collide with each other. */
function cacheKey(guildId: string, normalizedCommand: string): string {
  return `${guildId}:${normalizedCommand}`;
}

/**
 * Builds a counter lookup cache keyed by guild + normalized trigger/check command, sorted by
 * counter id so the lowest id wins on collision within the same guild. Logs a warning and skips
 * the duplicate on any collision.
 * @param counters Counters to index, across every guild.
 * @returns The populated `CounterLookupCache`.
 */
function buildCounterLookupCache(counters: DbCounter[]): CounterLookupCache {
  const byCommand = new Map<string, DbMatchedCounter>();
  const sortedCounters = [...counters].sort((left, right) => left.id - right.id);

  const registerCounterCommand = (
    normalizedCommand: string,
    counter: DbCounter,
    matchType: CounterMatchType,
    commandFieldLabel: 'trigger_command' | 'check_command',
  ): void => {
    if (!normalizedCommand) return;

    registerFirstWinsWithWarning(
      byCommand,
      cacheKey(counter.guild_id, normalizedCommand),
      { ...counter, matchType },
      (existingCounter) => `Counter ${commandFieldLabel} collision: '${normalizedCommand}' in guild ${counter.guild_id} is already registered (counter id=${existingCounter.id}); ignoring duplicate from counter id=${counter.id}.`,
    );
  };

  for (const counter of sortedCounters) {
    registerCounterCommand(normalizeCommand(counter.trigger_command) ?? '', counter, 'trigger', 'trigger_command');
    registerCounterCommand(normalizeCommand(counter.check_command) ?? '', counter, 'check', 'check_command');
  }

  return { loadedAt: Date.now(), byCommand };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const counterLookupCacheState = createManagedLookupCache<CounterLookupCache>({
  cacheName: 'counter cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCounterLookupCache,
  loadCache: async () => buildCounterLookupCache(await getAllCounters()),
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the counter lookup cache as stale so the next read triggers a refresh. */
export function invalidateCounterLookupCache(): void {
  counterLookupCacheState.invalidate();
}

/** Looks up a counter by its trigger or check command string within one guild; returns null if
 *  not found in that guild (even if the same command matches a counter in a different guild). */
export async function findCounterByCommand(guildId: string, command: string): Promise<DbMatchedCounter | null> {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) return null;

  const cache = await counterLookupCacheState.getCache();
  const counter = cache.byCommand.get(cacheKey(guildId, normalizedCommand));
  return counter ? { ...counter } : null;
}

/** Returns true if any of the given commands conflict with an existing counter in this guild
 *  (optionally excluding one by ID). Counters in other guilds never collide. */
export async function isCounterCommandTaken(guildId: string, commandOrCommands: string | string[], excludeCounterId?: number): Promise<boolean> {
  if (Array.isArray(commandOrCommands)) {
    const normalizedCommands = normalizeCommandList(commandOrCommands);
    if (new Set(normalizedCommands).size !== normalizedCommands.length) {
      return true;
    }
  }

  return isAnyCommandTakenAcrossTables(commandOrCommands, { excludeCounterId, guildId });
}
