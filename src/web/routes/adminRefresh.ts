import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildMemberUsers, updateDiscordName } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager, requireManagerJson } from '../middleware';
import { getCurrentGuildId } from '../session';
import { getDiscordClient, fetchMemberDisplayName } from '../../discord/discordBot';
import { runUserMutation } from './adminUserMutationQueue';
import {
  type RefreshOutcome, type RefreshState, refreshStates, getRefreshState, forgetGuildRefreshState,
} from '../../discord/guildRefreshState';

export type { RefreshOutcome, RefreshState };
export { refreshStates, getRefreshState, forgetGuildRefreshState };

const log = createLogger('Web');

/**
 * Re-fetches each of `guildId`'s members' current Discord display name and persists any that
 * changed, tracking progress/outcome in `refreshStates` for `/users/refresh-status` to poll.
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
    let updatedCount = 0;
    let failureCount = 0;

    for (const user of users) {
      try {
        const name = await fetchMemberDisplayName(user.discord_id, guildId, true);
        if (name == null) {
          failureCount++;
          state.failureCount = failureCount;
          log.error(`Failed to refresh Discord name for ${user.discord_id}: Discord lookup returned no display name`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }

        const trimmedName = name?.trim();
        if (trimmedName && trimmedName !== user.discord_name) {
          await runUserMutation(user.discord_id, () => updateDiscordName(user.discord_id, trimmedName));
          updatedCount++;
          state.updatedCount = updatedCount;
        }
      } catch (err) {
        failureCount++;
        state.failureCount = failureCount;
        log.error(`Failed to refresh Discord name for ${user.discord_id}:`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    state.updatedCount = updatedCount;
    state.failureCount = failureCount;
    state.outcome = updatedCount > 0
      ? (failureCount > 0 ? 'partial' : 'success')
      : (failureCount > 0 ? 'error' : 'noop');
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
router.post('/users/refresh-names', requireManager, csrfProtection, async (req, res) => {
  const guildId = getCurrentGuildId(req);
  if (getRefreshState(guildId).outcome === 'running') {
    return res.redirect('/admin/users');
  }
  void runDiscordNameRefresh(guildId);
  return res.redirect('/admin/users');
});

export default router;
