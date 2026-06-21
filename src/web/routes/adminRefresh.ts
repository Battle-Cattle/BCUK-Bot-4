import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { getGuildMemberUsers, updateDiscordName } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getDiscordClient, fetchMemberDisplayName } from '../../discord/discordBot';
import { userMutationQueue } from './adminUserMutationQueue';

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

function idleRefreshState(): RefreshState {
  return { outcome: 'idle', updatedCount: 0, failureCount: 0, startedAt: null, finishedAt: null };
}

// Per-guild progress state, intentionally in-process because the web panel runs as
// a single bot instance today. If the panel is ever scaled horizontally, move this
// state into shared storage before relying on /users/refresh-status.
export const refreshStates = new Map<string, RefreshState>();

/** Returns the Discord-name-refresh progress for a guild, defaulting to idle when no refresh has run yet. */
export function getRefreshState(guildId: string): RefreshState {
  return refreshStates.get(guildId) ?? idleRefreshState();
}

const log = createLogger('Web');

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
        const name = await fetchMemberDisplayName(user.discord_id, true, guildId);
        if (name == null) {
          failureCount++;
          state.failureCount = failureCount;
          log.error(`Failed to refresh Discord name for ${user.discord_id}: Discord lookup returned no display name`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }

        const trimmedName = name?.trim();
        if (trimmedName && trimmedName !== user.discord_name) {
          await userMutationQueue.run(user.discord_id, () => updateDiscordName(user.discord_id, trimmedName));
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
router.get('/users/refresh-status', requireManager, (req, res) => {
  res.json(getRefreshState(req.session.user!.currentGuildId!));
});

router.post('/users/refresh-names', requireManager, csrfProtection, async (req, res) => {
  const guildId = req.session.user!.currentGuildId!;
  if (getRefreshState(guildId).outcome === 'running') {
    return res.redirect('/admin/users');
  }
  void runDiscordNameRefresh(guildId);
  return res.redirect('/admin/users');
});

export default router;
