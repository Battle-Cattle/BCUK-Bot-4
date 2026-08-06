export type { RefreshingLookupCache, ManagedLookupCacheOptions, ManagedLookupCache } from './db/lookupCache';
export {
  createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './db/lookupCache';
export { getPool, closePool } from './db/pool';

// ─── Guilds ──────────────────────────────────────────────────────────────────

export {
  getAllGuilds, getProvisionedGuilds, getGuildById, getGuildsForMember, upsertGuild,
} from './db/guilds';
export type { DbGuild } from './db/guilds';

export {
  getMemberAccessLevel, setMemberAccessLevel,
  removeGuildMember, getEffectiveAccessLevelForUser,
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
  findUser, findUsersByIds, findUserByTwitchName, getAllUsers, getGuildMemberUsers,
  updateDiscordName, getTwitchEnabledChannels, getAllTwitchLinkedUsers,
} from './db/users';
export type { AccessLevelValue, DbUser, TwitchLinkedUser } from './db/users';

import { upsertUserRecord, setTwitchBotEnabledRecord } from './db/users';

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

// ─── Custom commands ────────────────────────────────────────────────────────

import { invalidateCustomCommandLookupCache } from './db/customCommandCache';
import {
  addCustomCommand as addCustomCommandRecord,
  updateCustomCommand as updateCustomCommandRecord,
  removeCustomCommand as removeCustomCommandRecord,
  assignUserToCommand as assignUserToCommandRecord,
  assignUsersToCommand as assignUsersToCommandRecord,
  unassignUserFromCommand as unassignUserFromCommandRecord,
} from './db/customCommands';
export { getAllCustomCommandsWithAssignments, getCustomCommandCount } from './db/customCommands';
export type {
  DbCustomCommand, DbCustomCommandAssignedUser, DbCustomCommandWithAssignments,
} from './db/customCommands';
export {
  invalidateCustomCommandLookupCache,
  getCustomCommandForTwitchChannel, getCustomCommandForDiscord,
} from './db/customCommandCache';

// customCommands.ts is now a pure DB layer with no cache knowledge (breaks its import cycle
// with customCommandCache.ts); these wrappers add the cache invalidation that used to live
// there, reusing the same withInvalidation() helper already used above for users.ts/
// guildCommandOverrides.ts.

/**
 * Creates a new custom command and invalidates the custom-command lookup cache.
 * @param triggerString - Full prefixed command string (e.g. `!clap`).
 * @param output - Response text.
 * @param isDiscordEnabled - When true, the command responds in Discord.
 * @param isMultiTwitch - When true, the command can be assigned to multiple Twitch streamers.
 * @returns The auto-incremented `command_id` of the newly created row.
 */
export async function addCustomCommand(
  triggerString: string, output: string, isDiscordEnabled: boolean, isMultiTwitch: boolean,
): Promise<number> {
  return withInvalidation(() => addCustomCommandRecord(triggerString, output, isDiscordEnabled, isMultiTwitch));
}

/**
 * Updates an existing custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to update.
 * @param triggerString - New trigger string.
 * @param output - New response text.
 * @param isDiscordEnabled - Whether the command responds in Discord.
 * @param isMultiTwitch - Whether the command can be assigned to multiple Twitch streamers.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateCustomCommand(
  commandId: number, triggerString: string, output: string, isDiscordEnabled: boolean, isMultiTwitch: boolean,
): Promise<void> {
  return withInvalidation(
    () => updateCustomCommandRecord(commandId, triggerString, output, isDiscordEnabled, isMultiTwitch),
  );
}

/**
 * Deletes a custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to delete.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeCustomCommand(commandId: number): Promise<void> {
  return withInvalidation(() => removeCustomCommandRecord(commandId));
}

/**
 * Assigns a Discord user to a custom command and invalidates the custom-command lookup cache.
 * @param commandId - ID of the command to assign the user to.
 * @param discordId - Discord snowflake of the user to assign.
 * @returns Resolves once the assignment (and cache invalidation) completes.
 */
export async function assignUserToCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(() => assignUserToCommandRecord(commandId, discordId));
}

/**
 * Assigns multiple Discord users to a custom command and invalidates the custom-command
 * lookup cache.
 * @param commandId - ID of the command to assign the users to.
 * @param discordIds - Discord snowflakes of the users to assign.
 * @returns Resolves once the assignment (and cache invalidation) completes.
 */
export async function assignUsersToCommand(commandId: number, discordIds: string[]): Promise<void> {
  return withInvalidation(() => assignUsersToCommandRecord(commandId, discordIds));
}

/**
 * Removes a Discord user's assignment from a custom command and invalidates the
 * custom-command lookup cache.
 * @param commandId - ID of the command to remove the assignment from.
 * @param discordId - Discord snowflake of the user to unassign.
 * @returns Resolves once the removal (and cache invalidation) completes.
 */
export async function unassignUserFromCommand(commandId: number, discordId: string): Promise<void> {
  return withInvalidation(() => unassignUserFromCommandRecord(commandId, discordId));
}
export {
  CommandNotFoundError, CommandConflictError, isMysqlDuplicateEntryError,
  isCustomCommandTriggerTaken,
} from './db/commandLocks';
export { ReservedCommandError, RESERVED_BUILT_IN_COMMANDS } from './db/reservedCommands';
export type { SqlExecutor } from './db/commandLocks';

// ─── Counter commands ───────────────────────────────────────────────────────

export { CounterNotFoundError, getAllCounters, getCounterCount, getCounterHistory } from './db/counters';
export type { DbCounter, CounterMatchType, DbMatchedCounter, UpdateCounterInput, CounterHistoryEntry } from './db/counters';
export { invalidateCounterLookupCache, findCounterByCommand, isCounterCommandTaken } from './db/counterCache';

import {
  addCounter as addCounterRecord,
  updateCounter as updateCounterRecord,
  removeCounter as removeCounterRecord,
  resetCounterCurrentValue as resetCounterCurrentValueRecord,
  incrementCounter as incrementCounterRecord,
  archiveAndResetYearlyCounters as archiveAndResetYearlyCountersRecord,
} from './db/counters';
import type { UpdateCounterInput } from './db/counters';
import { invalidateCounterLookupCache } from './db/counterCache';

// counters.ts is now a pure DB layer with no cache knowledge (breaks its import cycle with
// counterCache.ts); these wrappers add the cache invalidation that used to live there.

/**
 * Creates a new counter and invalidates the counter lookup cache.
 * @param triggerCommand - Command that increments the counter.
 * @param checkCommand - Command that reports the counter's current value.
 * @param message - Message shown when the counter is checked.
 * @param incrementMessage - Message shown when the counter is incremented.
 * @param resetYearly - Whether the counter's value is archived and reset each new year.
 * @returns Resolves once the insert (and cache invalidation) completes.
 */
export async function addCounter(
  triggerCommand: string, checkCommand: string, message: string, incrementMessage: string, resetYearly: boolean,
): Promise<void> {
  await addCounterRecord(triggerCommand, checkCommand, message, incrementMessage, resetYearly);
  invalidateCounterLookupCache();
}

/**
 * Updates an existing counter's fields and invalidates the counter lookup cache.
 * @param input - The counter's id and updated fields.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function updateCounter(input: UpdateCounterInput): Promise<void> {
  await updateCounterRecord(input);
  invalidateCounterLookupCache();
}

/**
 * Deletes a counter by id and invalidates the counter lookup cache.
 * @param id - The counter's numeric id.
 * @returns Resolves once the deletion (and cache invalidation) completes.
 */
export async function removeCounter(id: number): Promise<void> {
  await removeCounterRecord(id);
  invalidateCounterLookupCache();
}

/**
 * Resets a counter's current value to 0 and invalidates the counter lookup cache.
 * @param id - The counter's numeric id.
 * @returns Resolves once the update (and cache invalidation) completes.
 */
export async function resetCounterCurrentValue(id: number): Promise<void> {
  await resetCounterCurrentValueRecord(id);
  invalidateCounterLookupCache();
}

/**
 * Atomically increments a counter's current value and invalidates the counter lookup cache.
 * @param id - The counter's numeric id.
 * @returns The counter's current value after the increment.
 */
export async function incrementCounter(id: number): Promise<number> {
  const newValue = await incrementCounterRecord(id);
  invalidateCounterLookupCache();
  return newValue;
}

/**
 * Archives and resets every yearly-reset counter for the given year, and invalidates the
 * counter lookup cache.
 * @param year - Calendar year to archive into.
 * @returns The number of counters archived and reset.
 */
export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  const affectedRows = await archiveAndResetYearlyCountersRecord(year);
  invalidateCounterLookupCache();
  return affectedRows;
}

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
  DEFAULT_EVENT_CONFIG,
} from './db/eventSub';
export type { DbStreamerEventSub, EventSubConfig } from './db/eventSub';

// ─── Alerts overlay ─────────────────────────────────────────────────────────

export type { AlertConfig, AlertEventType, TextAnimation } from './db/alertConfig';
export { ALERT_EVENT_TYPES, ALERT_TEXT_ANIMATIONS } from './db/alertConfig';
export { getAlertConfigsForStreamer, getAlertConfig, getEnabledAlertEventTypesBatch } from './db/alertConfig';
export { findCachedAlertConfig } from './db/alertConfigCache';

import {
  initAlertConfigs as initAlertConfigsRecord,
  saveAlertConfig as saveAlertConfigRecord,
  setAlertImage as setAlertImageRecord,
  setAlertSound as setAlertSoundRecord,
} from './db/alertConfig';
import type { AlertEventType, TextAnimation } from './db/alertConfig';
import { invalidateAlertConfigLookupCache } from './db/alertConfigCache';

// alertConfig.ts is now a pure DB layer with no cache knowledge (breaks its import cycle with
// alertConfigCache.ts); these wrappers add the cache invalidation that used to live there.

/**
 * Inserts default (disabled) alert config rows for all event types for a streamer and
 * invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer to initialise alert config for.
 * @returns Resolves once the insert (and cache invalidation) completes.
 */
export async function initAlertConfigs(streamerId: number): Promise<void> {
  await initAlertConfigsRecord(streamerId);
  invalidateAlertConfigLookupCache();
}

/**
 * Upserts a streamer's alert config for one event type and invalidates the alert config
 * lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param config - The fields to persist.
 * @returns Resolves once the upsert (and cache invalidation) completes.
 */
export async function saveAlertConfig(
  streamerId: number,
  eventType: AlertEventType,
  config: { enabled: boolean; message_template: string; duration_ms: number; text_animation: TextAnimation },
): Promise<void> {
  await saveAlertConfigRecord(streamerId, eventType, config);
  invalidateAlertConfigLookupCache();
}

/**
 * Sets (or clears) a streamer's alert image and invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param filename - The new stored filename, or null to clear the image.
 * @returns The previous filename, or null if there was none.
 */
export async function setAlertImage(
  streamerId: number, eventType: AlertEventType, filename: string | null,
): Promise<string | null> {
  const previous = await setAlertImageRecord(streamerId, eventType, filename);
  invalidateAlertConfigLookupCache();
  return previous;
}

/**
 * Sets (or clears) a streamer's alert sound and invalidates the alert config lookup cache.
 * @param streamerId - DB row ID of the streamer.
 * @param eventType - The alert event type being configured.
 * @param filename - The new stored filename, or null to clear the sound.
 * @returns The previous filename, or null if there was none.
 */
export async function setAlertSound(
  streamerId: number, eventType: AlertEventType, filename: string | null,
): Promise<string | null> {
  const previous = await setAlertSoundRecord(streamerId, eventType, filename);
  invalidateAlertConfigLookupCache();
  return previous;
}

// ─── Streamer event log ──────────────────────────────────────────────────────

export type { StreamerEventType, StreamerEvent } from './db/eventLog';
export { recordStreamerEvent, getRecentStreamerEvents } from './db/eventLog';

// ─── SFX ────────────────────────────────────────────────────────────────────

export type { SfxTrigger, SfxFile, SfxTriggerRow, PublicSfxTrigger, SfxCategory } from './db/sfx';
export {
  findTrigger, findSoundFiles, getAllSfxTriggers, getSfxTriggerCount, getPublicSfxTriggers,
  getAllCategories, createCategory, renameCategory, deleteCategory, getSfxFileById,
} from './db/sfx';
export type { SfxLookupResult } from './db/sfxCache';
export { findCachedSfxTrigger } from './db/sfxCache';

import {
  createSfxTrigger as createSfxTriggerRecord,
  updateSfxTrigger as updateSfxTriggerRecord,
  deleteSfxTrigger as deleteSfxTriggerRecord,
  addSfxFile as addSfxFileRecord,
  updateSfxFile as updateSfxFileRecord,
  deleteSfxFile as deleteSfxFileRecord,
} from './db/sfx';
import { invalidateSfxLookupCache } from './db/sfxCache';

// sfx.ts is now a pure DB layer with no cache knowledge (breaks its import cycle with
// sfxCache.ts); these wrappers add the cache invalidation that used to live there.

/**
 * Creates a new SFX trigger and invalidates the SFX lookup cache.
 * @param command - Full prefixed command string, e.g. `!clap`.
 * @param categoryId - Category id, or null for uncategorised.
 * @param description - Optional public description, or null.
 * @param hidden - Whether the trigger is hidden from the public listing.
 * @returns The new trigger id.
 */
export async function createSfxTrigger(
  command: string, categoryId: number | null, description: string | null, hidden: boolean,
): Promise<bigint> {
  const id = await createSfxTriggerRecord(command, categoryId, description, hidden);
  invalidateSfxLookupCache();
  return id;
}

/**
 * Updates an existing SFX trigger and invalidates the SFX lookup cache if it existed.
 * @param id - Trigger id.
 * @param command - Full prefixed command string, e.g. `!clap`.
 * @param categoryId - Category id, or null for uncategorised.
 * @param description - Optional public description, or null.
 * @param hidden - Whether the trigger is hidden from the public listing.
 * @returns true if the trigger exists, false if no trigger with that id existed.
 */
export async function updateSfxTrigger(
  id: bigint, command: string, categoryId: number | null, description: string | null, hidden: boolean,
): Promise<boolean> {
  const updated = await updateSfxTriggerRecord(id, command, categoryId, description, hidden);
  if (updated) invalidateSfxLookupCache();
  return updated;
}

/**
 * Deletes an SFX trigger and its sound files, invalidating the SFX lookup cache if it existed.
 * @param id - Trigger id.
 * @returns The relative paths of the deleted sound files, or null if no trigger with that id
 *   existed.
 */
export async function deleteSfxTrigger(id: bigint): Promise<{ files: string[] } | null> {
  const result = await deleteSfxTriggerRecord(id);
  if (result !== null) invalidateSfxLookupCache();
  return result;
}

/**
 * Adds a sound file to a trigger and invalidates the SFX lookup cache.
 * @param triggerId - Owning trigger id.
 * @param file - Relative path (within SFX_FOLDER) of the stored audio file.
 * @param weight - Weighted-random selection weight (>= 1).
 * @param hidden - Whether the file is hidden from the public listing.
 * @returns The new sfx row id.
 */
export async function addSfxFile(
  triggerId: bigint, file: string, weight: number, hidden: boolean,
): Promise<number> {
  const id = await addSfxFileRecord(triggerId, file, weight, hidden);
  invalidateSfxLookupCache();
  return id;
}

/**
 * Updates a sound file's weight/hidden flag, invalidating the SFX lookup cache if it existed.
 * @param id - sfx row id.
 * @param weight - Weighted-random selection weight (>= 1).
 * @param hidden - Whether the file is hidden from the public listing.
 * @returns true if the sfx row exists, false if no sfx row with that id existed.
 */
export async function updateSfxFile(id: number, weight: number, hidden: boolean): Promise<boolean> {
  const updated = await updateSfxFileRecord(id, weight, hidden);
  if (updated) invalidateSfxLookupCache();
  return updated;
}

/**
 * Deletes a sound file row, invalidating the SFX lookup cache if it existed.
 * @param id - sfx row id.
 * @returns The deleted file's relative path, or null if no such row existed.
 */
export async function deleteSfxFile(id: number): Promise<string | null> {
  const file = await deleteSfxFileRecord(id);
  if (file !== null) invalidateSfxLookupCache();
  return file;
}

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
  getPricingForReward, getPricingConfigsForStreamer, getAllEnabledPricingRows,
  upsertPricingConfig, recordPricingUpdate, deletePricingConfig, markPricingUnsupported,
  updatePricingCooldownForReward, getPricingSettingsForStreamer, savePricingSettingsForStreamer,
  DEFAULT_PRICING_COOLDOWN_SECONDS,
} from './db/rewardPricing';

export type { RewardPricingHistoryPoint } from './db/rewardPricingHistory';
export { recordPricingHistory, getPricingHistoryForRewards } from './db/rewardPricingHistory';

// ─── Timer commands ─────────────────────────────────────────────────────────

export type {
  DbTimerCommand, DbTimerCommandAssignedUser, DbTimerCommandWithAssignments,
  TimerCommandInput, TimerCommandForScheduler,
} from './db/timerCommands';
export {
  TimerCommandNotFoundError,
  getAllTimerCommandsWithAssignments, addTimerCommand, updateTimerCommand,
  removeTimerCommand, setTimerCommandEnabled, getAllEnabledTimerCommandsWithChannel,
  assignUserToTimer, assignUsersToTimer, unassignUserFromTimer,
} from './db/timerCommands';

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
export { createCode, exchangeCodeForToken } from './db/companionOAuthCodes';
