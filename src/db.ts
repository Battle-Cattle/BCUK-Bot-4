export type { RefreshingLookupCache, ManagedLookupCacheOptions, ManagedLookupCache } from './db/lookupCache';
export {
  createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './db/lookupCache';
export { getPool, closePool } from './db/pool';

// ─── Guilds ──────────────────────────────────────────────────────────────────

export {
  getAllGuilds, getProvisionedGuilds, getGuildById, getGuildsForMember, upsertGuild, setGuildVoiceChannel,
} from './db/guilds';
export type { DbGuild } from './db/guilds';

export {
  getGuildMembers, getMemberAccessLevel, setMemberAccessLevel,
  removeGuildMember, getEffectiveAccessLevel, getEffectiveAccessLevelForUser,
} from './db/guildMembers';
export type { DbGuildMember } from './db/guildMembers';

export { getOverridesForGuild, getAllOverrides } from './db/guildCommandOverrides';
export type { DbGuildCommandOverride } from './db/guildCommandOverrides';

import {
  upsertOverride as upsertOverrideRecord,
  removeOverride as removeOverrideRecord,
} from './db/guildCommandOverrides';

/**
 * Runs `operation`, then unconditionally invalidates the custom-command lookup cache.
 * Shared by the facade wrappers below that always need a post-write invalidation —
 * `users.ts`/`guildCommandOverrides.ts` are pure DB layers with no cache knowledge.
 * @param operation - The DB write to perform.
 * @returns The value returned by `operation`.
 */
async function withInvalidation<T>(operation: () => Promise<T>): Promise<T> {
  const result = await operation();
  invalidateCustomCommandLookupCache();
  return result;
}

/**
 * Inserts or updates a guild's override for a catalog command and invalidates
 * the custom-command lookup cache, since overrides affect Discord command resolution.
 * @param guildId - BIGINT snowflake as a string.
 * @param commandId - The catalog command's command_id.
 * @param override.isDisabled - When true, the command does not fire in this guild.
 * @param override.output - Replacement Discord output, or null to use the catalog output.
 * @returns Resolves once the upsert (and cache invalidation) completes.
 */
export async function upsertOverride(
  guildId: string,
  commandId: number,
  override: { isDisabled: boolean; output: string | null },
): Promise<void> {
  await withInvalidation(() => upsertOverrideRecord(guildId, commandId, override));
}

/**
 * Removes a guild's override for a command and invalidates the custom-command
 * lookup cache. No-op if the override is absent.
 * @param guildId - BIGINT snowflake as a string.
 * @param commandId - The catalog command's command_id.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeOverride(guildId: string, commandId: number): Promise<void> {
  await withInvalidation(() => removeOverrideRecord(guildId, commandId));
}

// ─── User / access-level ────────────────────────────────────────────────────

export {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUsersByIds, findUserByTwitchName, findOwnerUser, getAllUsers, getGuildMemberUsers,
  updateDiscordName, getTwitchEnabledChannels, getAllTwitchLinkedUsers, updateAccessLevel,
} from './db/users';
export type { AccessLevelValue, DbUser, TwitchLinkedUser } from './db/users';

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
  await withInvalidation(() => setTwitchBotEnabledRecord(discordId, enabled));
}

/**
 * Deletes a user record and invalidates the custom-command lookup cache.
 * @param discordId - Discord snowflake as a string.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeUser(discordId: string): Promise<void> {
  await withInvalidation(() => removeUserRecord(discordId));
}

// ─── Custom commands ────────────────────────────────────────────────────────

import { invalidateCustomCommandLookupCache } from './db/customCommandCache';
export {
  getAllCustomCommandsWithAssignments,
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  assignUserToCommand, assignUsersToCommand, unassignUserFromCommand,
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
  getCounterHistory,
} from './db/counters';
export type { DbCounter, CounterMatchType, DbMatchedCounter, UpdateCounterInput, CounterHistoryEntry } from './db/counters';
export { invalidateCounterLookupCache, findCounterByCommand, isCounterCommandTaken } from './db/counterCache';

// ─── Stream monitor ──────────────────────────────────────────────────────────

export {
  getStreamGroupsForGuild, addStreamGroup, updateStreamGroup,
  getStreamersForGuild, getAllStreamersWithGroups,
  addStreamer, removeStreamer, removeStreamGroupAndStreamers,
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

// ─── Alerts overlay ─────────────────────────────────────────────────────────

export type { AlertConfig, AlertEventType } from './db/alertConfig';
export { ALERT_EVENT_TYPES } from './db/alertConfig';
export {
  getAlertConfigsForStreamer, getAlertConfig, initAlertConfigs,
  saveAlertConfig, setAlertImage, setAlertSound,
} from './db/alertConfig';

// ─── SFX ────────────────────────────────────────────────────────────────────

export type { SfxTrigger, SfxFile, SfxTriggerRow, PublicSfxTrigger, SfxCategory } from './db/sfx';
export {
  findTrigger, findSoundFiles, getAllSfxTriggers, getPublicSfxTriggers,
  getAllCategories, createCategory, renameCategory, deleteCategory,
  createSfxTrigger, updateSfxTrigger, deleteSfxTrigger,
  addSfxFile, updateSfxFile, deleteSfxFile,
} from './db/sfx';
export type { SfxLookupResult } from './db/sfxCache';
export { findCachedSfxTrigger, invalidateSfxLookupCache } from './db/sfxCache';

// ─── Overlay videos ─────────────────────────────────────────────────────────

export type { OverlayVideo, OverlayReward, OverlayRewardWithVideos, OverlayWeightedVideo } from './db/overlayVideos';
export {
  getVideosForStreamer, addVideo, getVideoById, deleteVideo,
  getRewardsForStreamer, upsertReward, setRewardVideos, deleteReward,
  getVideosForReward,
} from './db/overlayVideos';

// ─── Channel point pricing ───────────────────────────────────────────────────

export type { RewardPricingRow, RewardPricingInput, StreamerPricingSettings } from './db/rewardPricing';
export {
  getPricingForReward, getPricingConfigById, getPricingConfigsForStreamer, getAllEnabledPricingRows,
  upsertPricingConfig, recordPricingUpdate, deletePricingConfig, markPricingUnsupported,
  updatePricingCooldownForReward, getPricingSettingsForStreamer, savePricingSettingsForStreamer,
  DEFAULT_PRICING_COOLDOWN_SECONDS,
} from './db/rewardPricing';

export type { RewardPricingHistoryPoint } from './db/rewardPricingHistory';
export { recordPricingHistory, getPricingHistory, getPricingHistoryForRewards } from './db/rewardPricingHistory';

// ─── Streamdeck API keys ─────────────────────────────────────────────────────

export type { StreamdeckKeyGuildStatusRow } from './db/streamdeckKeys';
export {
  hasApiKey,
  createApiKeyAndRequestGuildAccess,
  requestGuildAccessForExistingKey,
  rotateApiKey,
  findKeyByHash,
  isKeyApprovedForGuild,
  getApprovedGuildIdsForKey,
  getGuildStatusForKey,
  approveApiKey,
  denyApiKey,
  revokeApiKey,
  getPendingRequests,
  getAllApiKeys,
} from './db/streamdeckKeys';

// ─── Companion App ───────────────────────────────────────────────────────────

export type { CompanionTokenStatus } from './db/companionTokens';
export {
  issueToken,
  findDiscordIdByTokenHash,
  getTokenStatus,
  revokeToken,
} from './db/companionTokens';
export { createCode, consumeCode, exchangeCodeForToken } from './db/companionOAuthCodes';
