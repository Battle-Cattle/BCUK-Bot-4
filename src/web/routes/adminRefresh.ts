import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildMemberUsers, updateDiscordName } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager, requireManagerJson } from '../middleware';
import { getCurrentGuildId } from '../session';
import { fetchAllMemberDisplayNames, fetchMemberDisplayName } from '../../discord/discordApi';
import { getDiscordClient } from '../../discord/discordClientStore';
import { runUserMutation } from '../../shared/userMutationQueue';
import { type RefreshOutcome, type RefreshState, refreshStates, getRefreshState } from '../../discord/guildRefreshState';

const log = createLogger('Web');

/**
 * How many members a name refresh processes at once. On the per-member fallback each one is a REST
 * lookup; discord.js's REST manager queues and paces those against Discord's rate limits itself,
 * so a small pool beats a fixed sleep.
 */
export const REFRESH_CONCURRENCY = 5;

/** Resolves a member's current display name, or null if it can't be found. */
type DisplayNameLookup = (discordId: string) => Promise<string | null>;

/**
 * Picks how a refresh looks members' names up: one bulk member listing if Discord allows it
 * (Server Members intent enabled in the developer portal), else a forced per-member REST fetch.
 * @param guildId - Guild being refreshed.
 * @returns The lookup to use for every member of this run.
 */
async function resolveDisplayNameLookup(guildId: string): Promise<DisplayNameLookup> {
  const names = await fetchAllMemberDisplayNames(guildId);
  if (names) return (discordId) => Promise.resolve(names.get(discordId) ?? null);
  log.info(`Listing guild ${guildId} members failed; falling back to per-member Discord name lookups`);
  return (discordId) => fetchMemberDisplayName(discordId, guildId, true);
}

/**
 * Looks up one guild member's Discord display name and persists it if it changed. Never
 * throws — a failed lookup or write is logged and reported as `'failed'`.
 * @param user - The member's stored Discord id and current display name.
 * @param lookup - Resolves the member's current display name.
 * @returns `'updated'` if the stored name changed, `'unchanged'` if it didn't, or `'failed'`.
 */
async function refreshMemberName(
  user: { discord_id: string; discord_name: string | null }, lookup: DisplayNameLookup,
): Promise<'updated' | 'unchanged' | 'failed'> {
  try {
    const name = await lookup(user.discord_id);
    if (name == null) {
      log.error(`Failed to refresh Discord name for ${user.discord_id}: Discord lookup returned no display name`);
      return 'failed';
    }
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === user.discord_name) return 'unchanged';
    await runUserMutation(user.discord_id, () => updateDiscordName(user.discord_id, trimmedName));
    return 'updated';
  } catch (err) {
    log.error(`Failed to refresh Discord name for ${user.discord_id}:`, err);
    return 'failed';
  }
}

/**
 * Refreshes every member's name, up to `REFRESH_CONCURRENCY` at a time, bumping `state`'s
 * counters as each one finishes so the polling endpoint shows live progress.
 * @param users - The guild's registered members.
 * @param lookup - Resolves a member's current display name.
 * @param state - The run's progress record; its counters are mutated in place.
 */
async function refreshMemberNames(
  users: ReadonlyArray<{ discord_id: string; discord_name: string | null }>,
  lookup: DisplayNameLookup,
  state: RefreshState,
): Promise<void> {
  let next = 0;

  /** Pool worker: takes the next unprocessed member until none are left. */
  const worker = async (): Promise<void> => {
    while (next < users.length) {
      // next < users.length was checked just above, and nothing awaits in between.
      const user = users[next++]!;
      const result = await refreshMemberName(user, lookup);
      if (result === 'updated') state.updatedCount++;
      if (result === 'failed') state.failureCount++;
    }
  };
  const poolSize = Math.min(REFRESH_CONCURRENCY, users.length);
  await Promise.all(Array.from({ length: poolSize }, worker));
}

/**
 * Summarises a finished name-refresh run.
 * @param updatedCount - Members whose name changed.
 * @param failureCount - Members whose refresh failed.
 * @returns `'success'`/`'partial'` if anything was updated (without/with failures), else `'error'` if anything failed, else `'noop'`.
 */
function refreshOutcome(updatedCount: number, failureCount: number): RefreshOutcome {
  if (updatedCount > 0) return failureCount > 0 ? 'partial' : 'success';
  return failureCount > 0 ? 'error' : 'noop';
}

/**
 * Re-fetches each of `guildId`'s members' current Discord display name and persists any that
 * changed, tracking progress/outcome in `refreshStates` for `/users/refresh-status` to poll.
 * Lists all members' names in one paginated request when Discord allows it, falling back to
 * per-member lookups otherwise; runs up to `REFRESH_CONCURRENCY` members at a time either way.
 * @param guildId - Guild whose members' Discord names are refreshed.
 * @returns Resolves once every member has been processed (success, no-op, or per-member failure);
 *   never rejects — failures are recorded on the guild's `RefreshState` instead.
 */
async function runDiscordNameRefresh(guildId: string): Promise<void> {
  const state: RefreshState = { outcome: 'running', updatedCount: 0, failureCount: 0, startedAt: Date.now(), finishedAt: null };
  refreshStates.set(guildId, state);

  try {
    if (!getDiscordClient()) {
      throw new Error('Discord client is not ready');
    }

    const users = await getGuildMemberUsers(guildId);
    if (users.length > 0) {
      await refreshMemberNames(users, await resolveDisplayNameLookup(guildId), state);
    }

    state.outcome = refreshOutcome(state.updatedCount, state.failureCount);
  } catch (err) {
    state.failureCount = Math.max(state.failureCount, 1);
    state.outcome = 'error';
    log.error('Refresh Discord names failed:', err);
  } finally {
    state.finishedAt = Date.now();
  }
}

const router = Router();

// Mounted under /admin behind requireGuildContext, so currentGuildId is always set.

/**
 * GET /admin/users/refresh-status — polling endpoint for the current guild's
 * in-progress (or most recent) Discord-name-refresh job.
 * @param req - Express request; reads `getCurrentGuildId(req)`.
 * @param res - Express response; always responds 200 with the guild's `RefreshState`
 *   as JSON.
 */
router.get('/users/refresh-status', requireManagerJson, (req, res) => {
  res.json(getRefreshState(getCurrentGuildId(req)));
});

/**
 * POST /admin/users/refresh-names — kicks off a background job that re-fetches each
 * guild member's Discord display name and updates it if changed. No-ops if a refresh
 * is already running for the guild.
 * @param req - Express request; reads `getCurrentGuildId(req)`.
 * @param res - Express response; always redirects to `/admin/users` immediately —
 *   the refresh itself runs asynchronously and is polled via `/users/refresh-status`.
 */
router.post('/users/refresh-names', requireManager, csrfProtection, (req, res) => {
  const guildId = getCurrentGuildId(req);
  if (getRefreshState(guildId).outcome === 'running') {
    return res.redirect('/admin/users');
  }
  void runDiscordNameRefresh(guildId);
  return res.redirect('/admin/users');
});

export default router;
