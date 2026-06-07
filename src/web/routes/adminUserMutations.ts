import { createLogger } from '../../shared/logger';
import {
  getTwitchEnabledChannels,
  findUser,
  findUserByTwitchName,
  upsertUser,
  removeUser,
  updateTwitchBotEnabled,
  AccessLevelValue,
} from '../../db';
import { joinTwitchChannel, partTwitchChannel } from '../../twitch/twitchChannelMembership';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';

const log = createLogger('Web');

export class DuplicateTwitchNameError extends Error {
  constructor(twitchChannel: string) {
    super(`Twitch channel ${twitchChannel} is already assigned to another user`);
    this.name = 'DuplicateTwitchNameError';
  }
}

export function isLockWaitTimeoutDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const dbError = error as { errno?: number; code?: string };
  return dbError.errno === 1205 || dbError.code === 'ER_LOCK_WAIT_TIMEOUT';
}

export function isDuplicateTwitchNameDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const dbError = error as { code?: string; message?: string };
  return dbError.code === 'ER_DUP_ENTRY'
    && (dbError.message?.includes('ux_user_twitch_name') ?? false);
}

async function handleClearTwitchChannel(
  discordId: string,
  discordName: string,
  level: AccessLevelValue,
  previousChannel: string | null,
  wasBotEnabled: boolean,
): Promise<void> {
  try {
    // Persist disable first so the rollback path can safely restore both DB and runtime state.
    await updateTwitchBotEnabled(discordId, false);
    const enabledChannels = await getTwitchEnabledChannels();
    if (previousChannel && !enabledChannels.includes(previousChannel)) {
      await partTwitchChannel(previousChannel);
    }
  } catch (err) {
    try {
      await upsertUser(discordId, discordName, level, previousChannel ?? null);
      await updateTwitchBotEnabled(discordId, wasBotEnabled);
    } catch (rollbackErr) {
      log.error('Add user clear Twitch rollback failed:', rollbackErr);
    }
    throw err;
  }
}

interface ChangeTwitchChannelParams {
  discordId: string;
  discordName: string;
  level: AccessLevelValue;
  previousChannel: string | null;
  committedChannel: string;
  wasBotEnabled: boolean;
}

async function handleChangeTwitchChannel({
  discordId,
  discordName,
  level,
  previousChannel,
  committedChannel,
  wasBotEnabled,
}: ChangeTwitchChannelParams): Promise<void> {
  try {
    const enabledChannels = await getTwitchEnabledChannels();
    const shouldJoinCommittedChannel = enabledChannels.includes(committedChannel);
    const shouldPartPreviousChannel = !!previousChannel
      && previousChannel !== committedChannel
      && !enabledChannels.includes(previousChannel);

    if (shouldJoinCommittedChannel) {
      await joinTwitchChannel(committedChannel);
    }
    if (shouldPartPreviousChannel) {
      await partTwitchChannel(previousChannel);
    }
  } catch (err) {
    try {
      await upsertUser(discordId, discordName, level, previousChannel ?? null);
      await updateTwitchBotEnabled(discordId, wasBotEnabled);

      const rollbackEnabledChannels = await getTwitchEnabledChannels();
      const shouldRejoinPreviousChannel = !!previousChannel
        && rollbackEnabledChannels.includes(previousChannel);
      const shouldPartCommittedChannel = committedChannel !== previousChannel
        && !rollbackEnabledChannels.includes(committedChannel);

      if (shouldRejoinPreviousChannel) {
        await joinTwitchChannel(previousChannel);
      }
      if (shouldPartCommittedChannel) {
        await partTwitchChannel(committedChannel);
      }
    } catch (rollbackErr) {
      log.error('Add user DB rollback failed:', rollbackErr);
    }
    throw err;
  }
}

export interface AddOrUpdateParams {
  discordId: string;
  discordName: string;
  level: AccessLevelValue;
  normalizedTwitchName: string | null;
  shouldClearTwitchName: boolean;
}

export async function addOrUpdateUserMutation({
  discordId,
  discordName,
  level,
  normalizedTwitchName,
  shouldClearTwitchName,
}: AddOrUpdateParams): Promise<void> {
  const existingUser = await findUser(discordId);
  const previousChannel = existingUser?.twitch_name
    ? normalizeTwitchChannelName(existingUser.twitch_name)
    : null;
  const nextTwitchName = shouldClearTwitchName
    ? null
    : normalizedTwitchName ?? undefined;

  if (normalizedTwitchName) {
    const conflictingUser = await findUserByTwitchName(normalizedTwitchName, discordId);
    if (conflictingUser) {
      throw new DuplicateTwitchNameError(normalizedTwitchName);
    }
  }

  await upsertUser(discordId, discordName, level, nextTwitchName);

  const committedUser = await findUser(discordId);
  const committedChannel = committedUser?.twitch_name
    ? normalizeTwitchChannelName(committedUser.twitch_name)
    : null;

  if ((existingUser && !existingUser.is_twitch_bot_enabled) || previousChannel === committedChannel) {
    return;
  }

  if (!committedChannel) {
    await handleClearTwitchChannel(discordId, discordName, level, previousChannel, existingUser?.is_twitch_bot_enabled ?? false);
    return;
  }

  await handleChangeTwitchChannel({ discordId, discordName, level, previousChannel, committedChannel, wasBotEnabled: existingUser?.is_twitch_bot_enabled ?? false });
}

export async function removeUserMutation(discordId: string): Promise<void> {
  const existingUser = await findUser(discordId);
  await removeUser(discordId);

  if (!existingUser?.is_twitch_bot_enabled || !existingUser.twitch_name) {
    return;
  }

  const normalizedChannel = normalizeTwitchChannelName(existingUser.twitch_name);
  if (!normalizedChannel) {
    throw new Error('Removed user has an invalid Twitch channel');
  }

  const enabledChannels = await getTwitchEnabledChannels();
  if (enabledChannels.includes(normalizedChannel)) {
    return;
  }

  try {
    await partTwitchChannel(normalizedChannel);
  } catch (partErr) {
    try {
      await upsertUser(
        existingUser.discord_id,
        existingUser.discord_name?.trim() ?? '',
        existingUser.access_level as AccessLevelValue,
        existingUser.twitch_name ?? null,
      );
      await updateTwitchBotEnabled(existingUser.discord_id, existingUser.is_twitch_bot_enabled);
    } catch (rollbackErr) {
      log.error(`Failed to restore user after Twitch part failed during removal: ${discordId}`, rollbackErr);
    }
    throw partErr;
  }
}

export async function toggleTwitchMutation(discordId: string, nextEnabled: boolean): Promise<void> {
  const user = await findUser(discordId);
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

  await updateTwitchBotEnabled(discordId, nextEnabled);

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
      await updateTwitchBotEnabled(discordId, currentEnabled);
    } catch (rollbackErr) {
      log.error('Toggle twitch user rollback failed:', rollbackErr);
    }
    throw err;
  }
}
