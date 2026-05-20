import { Router } from 'express';
import { getAllUsers, updateDiscordName } from '../../db';
import { csrfProtection } from '../csrf';
import { requireManager } from '../middleware';
import { getDiscordClient, fetchMemberDisplayName } from '../../discordBot';

export type RefreshOutcome = 'idle' | 'running' | 'success' | 'partial' | 'noop' | 'error';

// This progress state is intentionally in-process because the web panel runs as
// a single bot instance today. If the panel is ever scaled horizontally, move
// this state into shared storage before relying on /users/refresh-status.
export const refreshState: {
  outcome: RefreshOutcome;
  updatedCount: number;
  failureCount: number;
  startedAt: number | null;
  finishedAt: number | null;
} = {
  outcome: 'idle',
  updatedCount: 0,
  failureCount: 0,
  startedAt: null,
  finishedAt: null,
};

async function runDiscordNameRefresh(): Promise<void> {
  refreshState.outcome = 'running';
  refreshState.updatedCount = 0;
  refreshState.failureCount = 0;
  refreshState.startedAt = Date.now();
  refreshState.finishedAt = null;

  try {
    if (!getDiscordClient()) {
      throw new Error('Discord client is not ready');
    }

    const users = await getAllUsers();
    let updatedCount = 0;
    let failureCount = 0;

    for (const user of users) {
      try {
        const name = await fetchMemberDisplayName(user.discord_id, true);
        if (name == null) {
          failureCount++;
          refreshState.failureCount = failureCount;
          console.error('[Web] Failed to refresh Discord name for ' + user.discord_id + ': Discord lookup returned no display name');
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }

        const trimmedName = name?.trim();
        if (trimmedName && trimmedName !== user.discord_name) {
          await updateDiscordName(user.discord_id, trimmedName);
          updatedCount++;
          refreshState.updatedCount = updatedCount;
        }
      } catch (err) {
        failureCount++;
        refreshState.failureCount = failureCount;
        console.error('[Web] Failed to refresh Discord name for', user.discord_id, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    refreshState.updatedCount = updatedCount;
    refreshState.failureCount = failureCount;
    refreshState.outcome = updatedCount > 0
      ? (failureCount > 0 ? 'partial' : 'success')
      : (failureCount > 0 ? 'error' : 'noop');
  } catch (err) {
    refreshState.failureCount = Math.max(refreshState.failureCount, 1);
    refreshState.outcome = 'error';
    console.error('[Web] Refresh Discord names failed:', err);
  } finally {
    refreshState.finishedAt = Date.now();
  }
}

const router = Router();

router.get('/users/refresh-status', requireManager, (_req, res) => {
  res.json(refreshState);
});

router.post('/users/refresh-names', requireManager, csrfProtection, async (_req, res) => {
  if (refreshState.outcome === 'running') {
    return res.redirect('/admin/users');
  }
  void runDiscordNameRefresh();
  return res.redirect('/admin/users');
});

export default router;
