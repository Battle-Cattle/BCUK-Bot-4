export type { RefreshingLookupCache, ManagedLookupCacheOptions, ManagedLookupCache } from './db/lookupCache';
export { getPool, closePool } from './db/pool';

// ─── Guilds ──────────────────────────────────────────────────────────────────

export {
  getAllGuilds, getProvisionedGuilds, getGuildById, getGuildsForMember, upsertGuild, setGuildVoiceChannel,
} from './db/guilds';
export type { DbGuild } from './db/guilds';

export {
  getGuildMembers, getMemberAccessLevel, setMemberAccessLevel,
  removeGuildMember, getEffectiveAccessLevel,
} from './db/guildMembers';
export type { DbGuildMember } from './db/guildMembers';

export {
  getOverridesForGuild, getAllOverrides, upsertOverride, removeOverride,
} from './db/guildCommandOverrides';
export type { DbGuildCommandOverride } from './db/guildCommandOverrides';

// ─── User / access-level ────────────────────────────────────────────────────

export {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUserByTwitchName, getAllUsers, getGuildMemberUsers,
  updateDiscordName, getTwitchEnabledChannels, updateAccessLevel,
} from './db/users';
export type { AccessLevelValue, DbUser } from './db/users';

import { upsertUserRecord, setTwitchBotEnabledRecord, removeUserRecord } from './db/users';

// Wrappers add cache invalidation — users.ts is a pure DB layer with no cache knowledge.

/**
 * Upserts a user record and invalidates the custom-command lookup cache when
 * the `twitchName` field is provided (including explicit null to clear it).
 * @param discordId - Discord snowflake as a string.
 * @param discordName - Display name to store; blank after trimming is stored as null.
 * @param accessLevel - Legacy global access level; must be one of `AccessLevel`'s values.
 * @param twitchName - Twitch channel name to set, or null to clear it; omit to leave unchanged.
 * @returns Resolves once the upsert (and any cache invalidation) completes.
 */
export async function upsertUser(
  discordId: string,
  discordName: string,
  accessLevel: number,
  twitchName?: string | null,
): Promise<void> {
  const twitchNameProvided = await upsertUserRecord(discordId, discordName, accessLevel, twitchName);
  if (twitchNameProvided) {
    invalidateCustomCommandLookupCache();
  }
}

/**
 * Sets whether a user's Twitch bot integration is enabled and invalidates the
 * custom-command lookup cache.
 * @param discordId - Discord snowflake as a string.
 * @param enabled - True to enable the Twitch bot for this user, false to disable it.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateTwitchBotEnabled(discordId: string, enabled: boolean): Promise<void> {
  await setTwitchBotEnabledRecord(discordId, enabled);
  invalidateCustomCommandLookupCache();
}

/**
 * Deletes a user record and invalidates the custom-command lookup cache.
 * @param discordId - Discord snowflake as a string.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeUser(discordId: string): Promise<void> {
  await removeUserRecord(discordId);
  invalidateCustomCommandLookupCache();
}

// ─── Custom commands ────────────────────────────────────────────────────────

import { invalidateCustomCommandLookupCache } from './db/customCommandCache';
export {
  getAllCustomCommandsWithAssignments,
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  assignUserToCommand, unassignUserFromCommand,
} from './db/customCommands';
export type {
  DbCustomCommand, DbCustomCommandAssignedUser, DbCustomCommandWithAssignments,
} from './db/customCommands';
export {
  invalidateCustomCommandLookupCache,
  getCustomCommandForTwitchChannel, getCustomCommandForDiscord,
} from './db/customCommandCache';
export {
  CommandNotFoundError, CommandConflictError, isMysqlDuplicateEntryError,
  isCustomCommandTriggerTaken,
} from './db/commandLocks';
export { ReservedCommandError, RESERVED_BUILT_IN_COMMANDS } from './db/reservedCommands';
export type { SqlExecutor } from './db/commandLocks';

// ─── Counter commands ───────────────────────────────────────────────────────

export {
  CounterNotFoundError,
  getAllCounters, addCounter, updateCounter, removeCounter,
  resetCounterCurrentValue, incrementCounter, archiveAndResetYearlyCounters,
} from './db/counters';
export type { DbCounter, CounterMatchType, DbMatchedCounter, UpdateCounterInput } from './db/counters';
export { invalidateCounterLookupCache, findCounterByCommand, isCounterCommandTaken } from './db/counterCache';

// ─── Stream monitor ──────────────────────────────────────────────────────────

export {
  getAllStreamGroups, addStreamGroup, updateStreamGroup, removeStreamGroup,
  getAllStreamers, getAllStreamersWithGroups,
  addStreamer, removeStreamer, removeStreamersByGroup,
  setStreamerLive, clearStreamerLive,
} from './db/streamMonitor';
export type {
  DbStreamGroup, AddStreamGroupInput, UpdateStreamGroupInput,
  DbStreamer, DbStreamerFull,
} from './db/streamMonitor';

// ─── EventSub ────────────────────────────────────────────────────────────────

export {
  getAllEventSubStreamers, getStreamerByDiscordId, getStreamerById,
  saveStreamerToken, clearStreamerToken, initEventConfig, saveEventConfig,
} from './db/eventSub';
export type { DbStreamerEventSub, EventSubConfig } from './db/eventSub';

// ─── SFX ────────────────────────────────────────────────────────────────────

export type { SfxTrigger, SfxFile, SfxTriggerRow, PublicSfxTrigger } from './db/sfx';
export { findTrigger, findSoundFiles, getAllSfxTriggers, getPublicSfxTriggers } from './db/sfx';

// ─── Overlay videos ─────────────────────────────────────────────────────────

export type { OverlayVideo, OverlayReward, OverlayRewardWithVideos, OverlayWeightedVideo } from './db/overlayVideos';
export {
  getVideosForStreamer, addVideo, getVideoById, deleteVideo,
  getRewardsForStreamer, upsertReward, setRewardVideos, deleteReward,
  getVideosForReward,
} from './db/overlayVideos';

// ─── Streamdeck API keys ─────────────────────────────────────────────────────

export type { StreamdeckKeyRow } from './db/streamdeckKeys';
export {
  requestApiKey,
  findApprovedKeyByHash,
  getApiKeyStatus,
  approveApiKey,
  denyApiKey,
  revokeApiKey,
  getPendingRequests,
  getAllApiKeys,
} from './db/streamdeckKeys';
