// Sends DM alerts to the bot owner through the Discord runtime registered from `index.ts`. The
// health watcher that decides when a component's failure or recovery is worth a DM lives in
// `ownerAlertWatcher.ts`.
import { createLogger } from '../shared/logger';
import { createRuntimeRegistry } from '../shared/runtimeRegistry';
import { findOwnerUser } from '../db';

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
  /**
   * Waits until {@link send} can deliver — alerts can be raised during startup (e.g. Twitch
   * reporting a missing bot token) before Discord has finished connecting. Omitted means "always
   * ready".
   * @returns Resolves once ready; rejects if the runtime doesn't become ready in time.
   */
  waitUntilReady?: () => Promise<void>;
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

/**
 * Caches the last successfully resolved owner Discord ID, so a `findOwnerUser()` failure (e.g.
 * the DB itself being down — the very case the health watcher most needs to alert about) doesn't also
 * prevent the alert from being sent. Cleared to `null` whenever a successful lookup confirms
 * there's no owner row (rather than left stale) — see {@link resolveOwnerDiscordId}.
 */
let cachedOwnerDiscordId: string | null = null;

/**
 * Resolves the Discord ID to DM: a fresh `findOwnerUser()` lookup when it succeeds (also
 * refreshing {@link cachedOwnerDiscordId}), falling back to the last cached ID only if the
 * lookup itself throws (e.g. the DB is down — exactly the case the health watcher needs to still be
 * able to alert about). A successful lookup that finds no owner row is authoritative — it clears
 * the cache and returns null, rather than falling back to a possibly-stale cached ID for an
 * owner that may have just been removed. Returns null (and logs) if there's no cached ID yet to
 * fall back to on a failed lookup.
 * @returns The Discord id to DM, or null if none is available.
 */
export async function resolveOwnerDiscordId(): Promise<string | null> {
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
 * Waits for `runtime` to be ready (see {@link OwnerAlertRuntime.waitUntilReady}), resolves the
 * owner's Discord ID, then — as the last step before the caller sends — confirms the alert is
 * still relevant, so a component that recovered during either wait doesn't get a stale DM. Logs
 * the reason whenever it gives up.
 * @param runtime - The registered owner-alert runtime.
 * @param message - The alert text, used only for logging.
 * @param isStillRelevant - Optional staleness check, run after both waits.
 * @returns The owner's Discord ID to DM, or null if the alert shouldn't be sent.
 */
async function resolveAlertRecipient(runtime: OwnerAlertRuntime, message: string, isStillRelevant?: () => boolean): Promise<string | null> {
  try {
    await runtime.waitUntilReady?.();
  } catch (err) {
    log.error('Owner-alert runtime never became ready — skipping alert:', message, err);
    return null;
  }
  const discordId = await resolveOwnerDiscordId();
  if (discordId && isStillRelevant && !isStillRelevant()) {
    log.info('Owner alert no longer relevant — skipping:', message);
    return null;
  }
  return discordId;
}

/**
 * Sends a DM alert to the bot owner via the registered runtime, first waiting for the runtime to
 * be ready (see {@link resolveAlertRecipient}). Never throws — a failed DM is logged and
 * swallowed so it can never crash the process (see {@link registerOwnerAlertRuntime}).
 * @param message - The alert text to send.
 * @param isStillRelevant - Optional check run immediately before sending (after every wait); if
 *   it returns false the alert is dropped as stale (e.g. a "down" alert for a component that
 *   recovered while this send was waiting on Discord or the owner lookup).
 * @returns Whether the DM was actually delivered — false if no runtime is registered, it never
 *   became ready, the alert went stale, the owner ID couldn't be resolved, or the send failed.
 */
export async function sendOwnerAlert(message: string, isStillRelevant?: () => boolean): Promise<boolean> {
  const runtime = runtimeRegistry.get();
  if (!runtime) {
    log.warn('No owner-alert runtime registered — skipping alert:', message);
    return false;
  }
  const discordId = await resolveAlertRecipient(runtime, message, isStillRelevant);
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
 * Sends a "shutting down" DM to the owner. Call as the first thing `index.ts`'s `shutdown()`
 * does once alerting itself has been turned off (see `stopOwnerAlertWatcher` in `ownerAlertWatcher.ts`) but before
 * any component — including the Discord client this DM itself needs — actually disconnects.
 * Pairs with {@link announceStartup}, sent once the next boot finishes: together they give an
 * explicit before/after pair for a deliberate restart, rather than leaving the owner to
 * reconstruct one from the edge-triggered component alerts (`ownerAlertWatcher.ts`), which lose all memory of a
 * "down" DM the instant the process that sent it exits.
 * @returns Resolves once the DM attempt has settled, whether delivered or not — never throws.
 */
export async function announceShutdown(): Promise<void> {
  await sendOwnerAlert('🟡 Shutting down for a restart.');
}

/**
 * Sends a "back online" DM to the owner. Call once every step of `index.ts`'s `main()` has
 * completed. Pairs with {@link announceShutdown}.
 * @returns Resolves once the DM attempt has settled, whether delivered or not — never throws.
 */
export async function announceStartup(): Promise<void> {
  await sendOwnerAlert('🟢 Back online.');
}

/** Test-only: forgets the cached owner Discord ID, so each test starts from a clean slate. */
export function __resetOwnerAlertsForTests(): void {
  cachedOwnerDiscordId = null;
}
