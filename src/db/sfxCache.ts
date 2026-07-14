import { createLogger } from '../shared/logger';
import {
  createManagedLookupCache,
  type RefreshingLookupCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './lookupCache';
import { normalizeCommand } from './commandStringUtils';
import { getAllSfxTriggers, type SfxTrigger, type SfxFile } from './sfx';

const log = createLogger('DB');

/** An SFX trigger paired with its playable sound files, as served from the lookup cache. */
export interface SfxLookupResult {
  trigger: SfxTrigger;
  files: SfxFile[];
}

interface SfxLookupCache extends RefreshingLookupCache {
  byTrigger: Map<string, SfxLookupResult>;
}

/**
 * Creates an empty, already-stale SFX lookup cache used as the initial/fallback state
 * before the first successful refresh.
 * @returns An empty `SfxLookupCache` with `loadedAt` set to 0.
 */
function createEmptySfxLookupCache(): SfxLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byTrigger: new Map<string, SfxLookupResult>(),
  };
}

/**
 * Builds an SFX lookup cache keyed by normalized trigger command, from the admin-panel
 * trigger+files listing. `sfxtrigger.trigger_command` has no DB-level uniqueness
 * constraint, so triggers are processed in ascending id order and a collision (two
 * triggers normalizing to the same command) logs a warning and keeps the lower-id
 * trigger, matching the collision-resolution convention used by the custom-command
 * and counter lookup caches.
 * @param triggers All SFX triggers with their associated sound files.
 * @returns The populated `SfxLookupCache`.
 */
function buildSfxLookupCache(triggers: Awaited<ReturnType<typeof getAllSfxTriggers>>): SfxLookupCache {
  const byTrigger = new Map<string, SfxLookupResult>();
  const sortedTriggers = [...triggers].sort((left, right) => {
    const leftId = BigInt(left.triggerId);
    const rightId = BigInt(right.triggerId);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

  for (const row of sortedTriggers) {
    const normalizedTriggerCommand = normalizeCommand(row.triggerCommand);
    if (!normalizedTriggerCommand) continue;

    const existing = byTrigger.get(normalizedTriggerCommand);
    if (existing) {
      log.warn(`SFX trigger collision: '${normalizedTriggerCommand}' is already registered (trigger id=${existing.trigger.id}); ignoring duplicate from trigger id=${row.triggerId}.`);
      continue;
    }

    // Frozen once here (not copied per-lookup in findCachedSfxTrigger) since callers only ever
    // read these objects; freezing turns any future accidental mutation into a loud failure
    // instead of silently corrupting the shared cache entry. Cast back to the mutable interface
    // shape (Object.freeze's return type is Readonly<T>) since callers never mutate in practice.
    const result: SfxLookupResult = {
      trigger: Object.freeze({
        id: BigInt(row.triggerId),
        trigger_command: row.triggerCommand,
        category_id: row.categoryId,
        hidden: row.hidden,
        description: row.description,
      }),
      files: Object.freeze(row.files.map((file) => Object.freeze({
        id: file.id,
        trigger_id: BigInt(row.triggerId),
        file: file.file,
        trigger_command: row.triggerCommand,
        weight: file.weight,
        hidden: file.hidden,
        category_id: row.categoryId,
      }))) as SfxFile[],
    };
    byTrigger.set(normalizedTriggerCommand, Object.freeze(result));
  }

  return { loadedAt: Date.now(), byTrigger };
}

// ─── Cache state ──────────────────────────────────────────────────────────────

const sfxLookupCacheState = createManagedLookupCache<SfxLookupCache>({
  cacheName: 'sfx cache',
  ttlMs: DEFAULT_CACHE_TTL_MS,
  refreshFailureBackoffMs: DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptySfxLookupCache,
  loadCache: async () => buildSfxLookupCache(await getAllSfxTriggers()),
});

// ─── Public API ───────────────────────────────────────────────────────────────

/** Marks the SFX lookup cache as stale so the next read triggers a refresh. */
export function invalidateSfxLookupCache(): void {
  sfxLookupCacheState.invalidate();
}

/**
 * Looks up an SFX trigger and its sound files by command string (case-insensitive).
 * Hidden triggers/files ARE included — the hidden flag only affects public listing, not playback.
 * @param command Trigger command string to match, matched case-insensitively.
 * @returns The matching trigger and its files, or null if none matches or the input is blank.
 */
export async function findCachedSfxTrigger(command: string): Promise<SfxLookupResult | null> {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) return null;

  const cache = await sfxLookupCacheState.getCache();
  return cache.byTrigger.get(normalizedCommand) ?? null;
}
