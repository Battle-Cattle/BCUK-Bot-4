import { Router } from 'express';
import {
  getAllUsers,
  getTwitchEnabledChannels,
  findUser,
  findUserByTwitchName,
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
import { normalizeTwitchChannelName } from '../../twitchChannelName';

const router = Router();

const KNOWN_ERRORS = new Set(['add_failed', 'duplicate_twitch_name', 'update_failed', 'remove_failed', 'toggle_failed']);
// Twitch membership changes are serialized per user in-process because this bot
// currently runs as a single web instance. If that changes, move this lock into
// shared storage or a DB transaction/row lock before scaling out.
const userMutationQueues = new Map<string, Promise<void>>();

type RefreshOutcome = 'idle' | 'running' | 'success' | 'partial' | 'noop' | 'error';

// This progress state is intentionally in-process because the web panel runs as
// a single bot instance today. If the panel is ever scaled horizontally, move
// this state into shared storage before relying on /users/refresh-status.
const refreshState: {
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

class DuplicateTwitchNameError extends Error {
  constructor(twitchChannel: string) {
    super(`Twitch channel ${twitchChannel} is already assigned to another user`);
    this.name = 'DuplicateTwitchNameError';
  }
}

function isDuplicateTwitchNameDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const dbError = error as { code?: string; message?: string };
  return dbError.code === 'ER_DUP_ENTRY'
    && (dbError.message?.includes('ux_user_twitch_name') ?? false);
}

async function withUserMutationLock<T>(discordId: string, operation: () => Promise<T>): Promise<T> {
  const previous = userMutationQueues.get(discordId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = (async () => {
    try {
      await previous;
    } catch {
      // Ignore failures from earlier queued operations so later mutations still run.
    }
    await current;
  })();
  userMutationQueues.set(discordId, queued);

  try {
    await previous;
  } catch {
    // Ignore failures from earlier queued operations so later mutations still run.
  }

  try {
    return await operation();
  } finally {
    release();
    if (userMutationQueues.get(discordId) === queued) {
      userMutationQueues.delete(discordId);
    }
  }
}

async function runDiscordNameRefresh(): Promise<void> {
  refreshState.outcome = 'running';
  refreshState.updatedCount = 0;
  refreshState.failureCount = 0;
  refreshState.startedAt = Date.now();
  refreshState.finishedAt = null;

  try {
    if (!discordClient) {
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
          console.error(`[Web] Failed to refresh Discord name for ${user.discord_id}: Discord lookup returned no display name`);
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
        console.error(`[Web] Failed to refresh Discord name for ${user.discord_id}:`, err);
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
  const { discord_id, discord_name, access_level, twitch_name, clear_twitch_name } = req.body as {
    discord_id?: string;
    discord_name?: string;
    access_level?: string;
    twitch_name?: string;
    clear_twitch_name?: string;
  };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId || !access_level) return res.redirect('/admin/users');
  const submittedTwitchName = (twitch_name ?? '').trim();
  const shouldClearTwitchName = clear_twitch_name === '1';
  const normalizedTwitchName = submittedTwitchName ? normalizeTwitchChannelName(submittedTwitchName) : null;
  const level = parseInt(access_level, 10);
  if (!Number.isFinite(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!(Object.values(AccessLevel) as number[]).includes(level)) return res.status(400).render('error', { message: 'Invalid access level.', user: req.session.user ?? null });
  if (!shouldClearTwitchName && submittedTwitchName && !normalizedTwitchName) {
    return res.status(400).render('error', {
      message: 'Invalid Twitch name.',
      user: req.session.user ?? null,
    });
  }
  if (trimmedDiscordId === req.session.user?.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot update your own account from this form.',
      user: req.session.user ?? null,
    });
  }
  try {
    await withUserMutationLock(trimmedDiscordId, async () => {
      const trimmedDiscordName = (discord_name ?? '').trim();
      const existingUser = await findUser(trimmedDiscordId);
      const previousTwitchChannel = existingUser?.twitch_name
        ? normalizeTwitchChannelName(existingUser.twitch_name)
        : null;
      const nextTwitchName = shouldClearTwitchName
        ? ''
        : normalizedTwitchName
          ? normalizedTwitchName
          : undefined;

      if (normalizedTwitchName) {
        const conflictingUser = await findUserByTwitchName(normalizedTwitchName, trimmedDiscordId);
        if (conflictingUser) {
          throw new DuplicateTwitchNameError(normalizedTwitchName);
        }
      }

      await upsertUser(
        trimmedDiscordId,
        trimmedDiscordName,
        level as AccessLevelValue,
        nextTwitchName,
      );

      const committedUser = await findUser(trimmedDiscordId);
      const committedTwitchChannel = committedUser?.twitch_name
        ? normalizeTwitchChannelName(committedUser.twitch_name)
        : null;

      if (!existingUser?.is_twitch_bot_enabled || previousTwitchChannel === committedTwitchChannel) {
        return;
      }

      if (!committedTwitchChannel) {
        try {
          // Persist disable first so the rollback path can safely restore both DB and runtime state.
          await updateTwitchBotEnabled(trimmedDiscordId, false);
          const enabledChannels = await getTwitchEnabledChannels();
          if (previousTwitchChannel && !enabledChannels.includes(previousTwitchChannel)) {
            await partTwitchChannel(previousTwitchChannel);
          }
        } catch (err) {
          try {
            await upsertUser(
              trimmedDiscordId,
              trimmedDiscordName,
              level as AccessLevelValue,
              previousTwitchChannel ?? '',
            );
            await updateTwitchBotEnabled(trimmedDiscordId, existingUser.is_twitch_bot_enabled);
          } catch (rollbackErr) {
            console.error('[Web] Add user clear Twitch rollback failed:', rollbackErr);
          }
          throw err;
        }
        return;
      }

      try {
        const enabledChannels = await getTwitchEnabledChannels();
        const shouldJoinCommittedChannel = enabledChannels.includes(committedTwitchChannel);
        const shouldPartPreviousChannel = !!previousTwitchChannel
          && previousTwitchChannel !== committedTwitchChannel
          && !enabledChannels.includes(previousTwitchChannel);

        if (shouldJoinCommittedChannel) {
          await joinTwitchChannel(committedTwitchChannel);
        }

        if (shouldPartPreviousChannel) {
          await partTwitchChannel(previousTwitchChannel);
        }
      } catch (err) {
        try {
          await upsertUser(
            trimmedDiscordId,
            trimmedDiscordName,
            level as AccessLevelValue,
            previousTwitchChannel ?? '',
          );
          await updateTwitchBotEnabled(trimmedDiscordId, existingUser.is_twitch_bot_enabled);

          const rollbackEnabledChannels = await getTwitchEnabledChannels();
          const shouldRejoinPreviousChannel = !!previousTwitchChannel
            && rollbackEnabledChannels.includes(previousTwitchChannel);
          const shouldPartCommittedChannel = committedTwitchChannel !== previousTwitchChannel
            && !rollbackEnabledChannels.includes(committedTwitchChannel);

          if (shouldRejoinPreviousChannel) {
            await joinTwitchChannel(previousTwitchChannel);
          }

          if (shouldPartCommittedChannel) {
            await partTwitchChannel(committedTwitchChannel);
          }
        } catch (rollbackErr) {
          console.error('[Web] Add user DB rollback failed:', rollbackErr);
        }
        throw err;
      }
    });
  } catch (err) {
    console.error('[Web] Add user error:', err);
    if (err instanceof DuplicateTwitchNameError || isDuplicateTwitchNameDbError(err)) {
      return res.redirect('/admin/users?error=duplicate_twitch_name');
    }
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
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  if (trimmedDiscordId === req.session.user!.discordId) {
    return res.status(400).render('error', {
      message: 'You cannot remove yourself.',
      user: req.session.user ?? null,
    });
  }
  try {
    await withUserMutationLock(trimmedDiscordId, async () => {
      const existingUser = await findUser(trimmedDiscordId);
      await removeUser(trimmedDiscordId);

      if (existingUser?.is_twitch_bot_enabled && existingUser.twitch_name) {
        const normalizedChannel = normalizeTwitchChannelName(existingUser.twitch_name);
        const enabledChannels = await getTwitchEnabledChannels();

        if (normalizedChannel && !enabledChannels.includes(normalizedChannel)) {
          try {
            await partTwitchChannel(normalizedChannel);
          } catch (partErr) {
            try {
              await upsertUser(
                existingUser.discord_id,
                existingUser.discord_name?.trim() ?? '',
                existingUser.access_level as AccessLevelValue,
                existingUser.twitch_name,
              );
              await updateTwitchBotEnabled(existingUser.discord_id, existingUser.is_twitch_bot_enabled);
            } catch (rollbackErr) {
              console.error(
                `[Web] Failed to restore user ${trimmedDiscordId} after Twitch part failed during removal:`,
                rollbackErr,
              );
            }
            throw partErr;
          }
        }
      }
    });
  } catch (err) {
    console.error('[Web] Remove user error:', err);
    return res.redirect('/admin/users?error=remove_failed');
  }
  res.redirect('/admin/users');
});

// Toggle twitch bot participation for a user (Manager+)
router.post('/users/toggle-twitch', requireManager, async (req, res) => {
  const { discord_id, is_twitch_bot_enabled } = req.body as {
    discord_id?: string;
    is_twitch_bot_enabled?: string;
  };
  const trimmedDiscordId = (discord_id ?? '').trim();
  if (!trimmedDiscordId) return res.redirect('/admin/users');

  let nextEnabled: boolean;
  if (is_twitch_bot_enabled === 'true' || is_twitch_bot_enabled === '1') {
    nextEnabled = true;
  } else if (is_twitch_bot_enabled === 'false' || is_twitch_bot_enabled === '0') {
    nextEnabled = false;
  } else {
    return res.status(400).render('error', {
      message: 'Invalid Twitch enabled state.',
      user: req.session.user ?? null,
    });
  }

  try {
    await withUserMutationLock(trimmedDiscordId, async () => {
      const user = await findUser(trimmedDiscordId);
      if (!user || !user.twitch_name) {
        throw new Error('Toggle target user is missing or has no Twitch channel');
      }

      const currentEnabled = user.is_twitch_bot_enabled;
      const normalizedChannel = normalizeTwitchChannelName(user.twitch_name);

      if (!normalizedChannel) {
        throw new Error('Toggle target user has an invalid Twitch channel');
      }

      if (currentEnabled === nextEnabled) {
        return;
      }

      await updateTwitchBotEnabled(trimmedDiscordId, nextEnabled);

      try {
        // joinTwitchChannel/partTwitchChannel are expected to throw on failure so
        // this rollback keeps DB state aligned with runtime channel membership.
        // Derive desired membership from the committed DB state so route handlers
        // always reconcile against the effective enabled-channel set.
        const enabledChannels = await getTwitchEnabledChannels();
        const shouldBeJoined = enabledChannels.includes(normalizedChannel);

        if (shouldBeJoined) {
          await joinTwitchChannel(normalizedChannel);
        } else {
          await partTwitchChannel(normalizedChannel);
        }
      } catch (err) {
        try {
          await updateTwitchBotEnabled(trimmedDiscordId, currentEnabled);
        } catch (rollbackErr) {
          console.error('[Web] Toggle twitch user rollback failed:', rollbackErr);
        }
        throw err;
      }
    });
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
