import { createLogger } from '../logger';
import { createManagedLookupCache, type RefreshingLookupCache } from './lookupCache';
import { normalizeCommandList } from './commandStringUtils';
import { isAnyCommandTakenAcrossTables } from './commandLocks';
// counters imports invalidateCounterLookupCache from this module;
// this module imports getAllCounters from counters.
// Both calls happen inside function bodies, so CommonJS resolves the cycle correctly.
import { getAllCounters, type DbCounter, type DbMatchedCounter, type CounterMatchType } from './counters';

const log = createLogger('DB');

// ─── Cache interface ──────────────────────────────────────────────────────────

interface CounterLookupCache extends RefreshingLookupCache {
  byCommand: Map<string, DbMatchedCounter>;
}

// ─── Cache builder ────────────────────────────────────────────────────────────

function createEmptyCounterLookupCache(): CounterLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byCommand: new Map<string, DbMatchedCounter>(),
  };
}

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

    const existingCounter = byCommand.get(normalizedCommand);
    if (existingCounter) {
      log.warn(`Counter ${commandFieldLabel} collision: '${normalizedCommand}' is already registered (counter id=${existingCounter.id}); ignoring duplicate from counter id=${counter.id}.`);
      return;
    }

    byCommand.set(normalizedCommand, { ...counter, matchType });
  };

  for (const counter of sortedCounters) {
    registerCounterCommand(counter.trigger_command.trim().toLowerCase(), counter, 'trigger', 'trigger_command');
    registerCounterCommand(counter.check_command.trim().toLowerCase(), counter, 'check', 'check_command');
  }

  return { loadedAt: Date.now(), byCommand };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const counterLookupCacheState = createManagedLookupCache<CounterLookupCache>({
  cacheName: 'counter cache',
  ttlMs: 300_000,
  refreshFailureBackoffMs: 5_000,
  refreshFailureMaxBackoffMs: 60_000,
  createEmptyCache: createEmptyCounterLookupCache,
  loadCache: async () => buildCounterLookupCache(await getAllCounters()),
});

// ─── Public API ───────────────────────────────────────────────────────────────

export function invalidateCounterLookupCache(): void {
  counterLookupCacheState.invalidate();
}

export async function findCounterByCommand(command: string): Promise<DbMatchedCounter | null> {
  const normalizedCommand = command.trim().toLowerCase();
  if (!normalizedCommand) return null;

  const cache = await counterLookupCacheState.getCache();
  const counter = cache.byCommand.get(normalizedCommand);
  return counter ? { ...counter } : null;
}

export async function isCounterCommandTaken(commandOrCommands: string | string[], excludeCounterId?: number): Promise<boolean> {
  if (Array.isArray(commandOrCommands)) {
    const normalizedCommands = normalizeCommandList(commandOrCommands);
    if (new Set(normalizedCommands).size !== normalizedCommands.length) {
      return true;
    }
  }

  return isAnyCommandTakenAcrossTables(commandOrCommands, { excludeCounterId });
}
