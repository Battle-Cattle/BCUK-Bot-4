import { Router } from 'express';
import {
  getAllUsers,
  findUser,
  upsertUser,
  removeUser,
  updateAccessLevel,
  updateDiscordName,
  updateTwitchBotEnabled,
  ACCESS_LEVEL_LABELS,
  AccessLevel,
  AccessLevelValue,
} from '../../db';
import { requireManager, requireAdmin } from '../middleware';
import { discordClient, fetchMemberDisplayName } from '../../discordBot';
import { joinTwitchChannel, partTwitchChannel } from '../../twitchBot';

const router = Router();

const KNOWN_ERRORS = new Set(['add_failed', 'update_failed', 'remove_failed', 'toggle_failed']);

type RefreshOutcome = 'idle' | 'running' | 'success' | 'noop' | 'error';

// This progress state is intentionally in-process because the web panel runs as
// a single bot instance today. If the panel is ever scaled horizontally, move
// this state into shared storage before relying on /users/refresh-status.
const refreshState: {
  outcome: RefreshOutcome;
  updatedCount: number;
  startedAt: number | null;
  finishedAt: number | null;
} = {
  outcome: 'idle',
  updatedCount: 0,
  startedAt: null,
  finishedAt: null,
};

async function runDiscordNameRefresh(): Promise<void> {
  refreshState.outcome = 'running';
  refreshState.updatedCount = 0;
  refreshState.startedAt = Date.now();
  refreshState.finishedAt = null;

  try {
    if (!discordClient) {
      throw new Error('Discord client is not ready');
    }

    const users = await getAllUsers();
    let updatedCount = 0;

    for (const user of users) {
      const name = await fetchMemberDisplayName(user.discord_id);
      const trimmedName = name?.trim();
      if (trimmedName && trimmedName !== user.discord_name) {
        await updateDiscordName(user.discord_id, trimmedName);
        updatedCount++;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    refreshState.updatedCount = updatedCount;
    refreshState.outcome = updatedCount > 0 ? 'success' : 'noop';
  } catch (err) {
    refreshState.outcome = 'error';
    console.error('[Web] Refresh Discord names failed:', err);
  } finally {
    refreshState.finishedAt = Date.now();
  }
}

// View user list (Manager+)
router.get('/users', requireManager, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.render('admin', {
      user: req.session.user,
      users,
      accessLevelLabels: ACCESS_LEVEL_LABELS,
      error: KNOWN_ERRORS.has(req.query.error as string) ? (req.query.error as string) : null,
      refreshState,
    });
  } catch (err) {
    console.error('[Web] Admin users error:', err);
    res.status(500).render('error', { message: 'Failed to load users.', user: req.session.user ?? null });
  }
});

router.get('/users/refresh-status', requireManager, (_req, res) => {
  res.json(refreshState);
});

// Add or update a user (Admin only)
router.post('/users/add', requireAdmin, async (req, res) => {
  const { discord_id, discord_name, access_level, twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
  };
  if (!discord_id || !access_level) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  try {
    const normalizedTwitchName = (twitch_name ?? '').trim();
    await upsertUser(
      discord_id.trim(),
      (discord_name ?? '').trim(),
      level as AccessLevelValue,
      normalizedTwitchName.length > 0 ? normalizedTwitchName : undefined,
    );
  } catch (err) {
    console.error('[Web] Add user error:', err);
    return res.redirect('/admin/users?error=add_failed');
  }
  res.redirect('/admin/users');
});

// Update access level (Admin only)
router.post('/users/update', requireAdmin, async (req, res) => {
  const { discord_id, access_level } = req.body as { discord_id?: string; access_level?: string };
  if (!discord_id || access_level === undefined) return res.redirect('/admin/users');
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });

  // Prevent demoting yourself
  if (discord_id === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot change your own access level.',
      user: req.session.user ?? null,
    });
  }
  try {
    await updateAccessLevel(discord_id, level);
  } catch (err) {
    console.error('[Web] Update access level error:', err);
    return res.redirect('/admin/users?error=update_failed');
  }
  res.redirect('/admin/users');
});

// Remove a user (Admin only)
router.post('/users/remove', requireAdmin, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id) return res.redirect('/admin/users');

  if (discord_id === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot remove yourself.',
      user: req.session.user ?? null,
    });
  }
  try {
    await removeUser(discord_id);
  } catch (err) {
    console.error('[Web] Remove user error:', err);
    return res.redirect('/admin/users?error=remove_failed');
  }
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, async (req, res) => {
  const { discord_id } = req.body as { discord_id?: string };
  if (!discord_id) return res.redirect('/admin/users');

  try {
    const user = await findUser(discord_id);
    if (!user || !user.twitch_name) {
      return res.redirect('/admin/users?error=toggle_failed');
    }

    const currentEnabled = user.is_twitch_bot_enabled;
    const nextEnabled = !currentEnabled;

    await updateTwitchBotEnabled(discord_id, nextEnabled);

    try {
      if (nextEnabled) {
        await joinTwitchChannel(user.twitch_name);
      } else {
        await partTwitchChannel(user.twitch_name);
      }
    } catch (err) {
      try {
        await updateTwitchBotEnabled(discord_id, currentEnabled);
      } catch (rollbackErr) {
        console.error('[Web] Toggle twitch user rollback failed:', rollbackErr);
      }
      throw err;
    }
  } catch (err) {
    console.error('[Web] Toggle twitch user error:', err);
    return res.redirect('/admin/users?error=toggle_failed');
  }

  res.redirect('/admin/users');
});

// Refresh Discord names for all users (Manager+)
router.post('/users/refresh-names', requireManager, async (req, res) => {
  if (refreshState.outcome === 'running') {
    return res.redirect('/admin/users');
  }

  void runDiscordNameRefresh();
  return res.redirect('/admin/users');
});

export default router;
