/**
 * Per-guild progress state for the Discord-name-refresh job, shared between the Discord bot
 * (which forgets a guild's state on `guildDelete`) and the admin web panel (which drives and
 * polls the job). Lives in its own module — rather than in `web/routes/adminRefresh.ts`, which
 * the Discord bot would otherwise have to import from directly — so `discord/discordBot.ts` and
 * `web/routes/adminRefresh.ts` can both depend on this without importing from each other.
 */

/** Lifecycle state of a guild's Discord-name-refresh job. */
export type RefreshOutcome = 'idle' | 'running' | 'success' | 'partial' | 'noop' | 'error';

/** Progress/result of a guild's most recent (or in-progress) Discord-name-refresh job. */
export interface RefreshState {
  outcome: RefreshOutcome;
  updatedCount: number;
  failureCount: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Returns a fresh idle `RefreshState`, used as the default for a guild with no recorded refresh. */
function idleRefreshState(): RefreshState {
  return { outcome: 'idle', updatedCount: 0, failureCount: 0, startedAt: null, finishedAt: null };
}

// Per-guild progress state, intentionally in-process because the web panel runs as
// a single bot instance today. If the panel is ever scaled horizontally, move this
// state into shared storage before relying on /users/refresh-status.
export const refreshStates = new Map<string, RefreshState>();

/**
 * Returns the Discord-name-refresh progress for a guild, defaulting to idle when no refresh has run yet.
 * @param guildId - Guild to look up.
 * @returns The guild's recorded `RefreshState`, or a fresh idle one if none has been recorded.
 */
export function getRefreshState(guildId: string): RefreshState {
  return refreshStates.get(guildId) ?? idleRefreshState();
}

/**
 * Forgets a guild's Discord-name-refresh progress state so it stops occupying
 * memory once the bot is no longer in that guild. Safe to call for a guild
 * with no state (no-op). Called from the `guildDelete` handler; a guild the
 * bot rejoins later starts fresh via {@link getRefreshState}'s idle default.
 *
 * @param guildId - Guild to forget.
 * @returns Nothing.
 */
export function forgetGuildRefreshState(guildId: string): void {
  refreshStates.delete(guildId);
}
