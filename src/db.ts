// Facade for the DB layer: callers import from here only, never `src/db/*` directly. Pure
// re-exports, except that writes to cached tables are re-exported from the `db/*Writes.ts`
// wrappers (which invalidate the matching lookup cache) instead of the raw DB modules.
export type { RefreshingLookupCache } from './db/lookupCache';
export {
  createManagedLookupCache,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
} from './db/lookupCache';
export { getPool, closePool } from './db/pool';
export { pingDb } from './db/health';

// ─── Guilds ──────────────────────────────────────────────────────────────────

export {
  getAllGuilds, getProvisionedGuilds, getGuildById, getGuildsForMember, upsertGuild,
} from './db/guilds';
export type { DbGuild } from './db/guilds';

export {
  getMemberAccessLevel, setMemberAccessLevel,
  removeGuildMember, getEffectiveAccessLevelForUser,
} from './db/guildMembers';

export { getOverridesForGuild } from './db/guildCommandOverrides';
export type { DbGuildCommandOverride } from './db/guildCommandOverrides';
export { upsertOverride, removeOverride } from './db/guildCommandOverrideWrites';

// ─── User / access-level ────────────────────────────────────────────────────

export {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUsersByIds, findUserByTwitchName, findOwnerUser, getGuildMemberUsers,
  updateDiscordName, getTwitchEnabledChannels, getAllTwitchLinkedUsers,
} from './db/users';
export type { AccessLevelValue, DbUser } from './db/users';
export { upsertUser, updateTwitchBotEnabled, deleteUnlinkedUser } from './db/userWrites';

// ─── Custom commands ────────────────────────────────────────────────────────

export { getAllCustomCommandsWithAssignments, getCustomCommandCount } from './db/customCommands';
export { isCommandSelfManageableBy } from './db/commandSelfService';
export { isTimerSelfManageableBy } from './db/timerSelfService';
export type {
  DbCustomCommand, DbCustomCommandAssignedUser, DbCustomCommandWithAssignments,
} from './db/customCommands';
export {
  getCustomCommandForTwitchChannel, getCustomCommandForDiscord,
} from './db/customCommandCache';
export {
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  updateOwnCustomCommand, removeOwnCustomCommand, discardOwnNewCustomCommand,
  assignUserToCommand, assignUsersToCommand, unassignUserFromCommand,
} from './db/customCommandWrites';
export { CommandNotFoundError, CommandSelfServiceDeniedError, CommandConflictError } from './db/commandErrors';
export { isMysqlDuplicateEntryError } from './db/utils';
export { ReservedCommandError } from './db/reservedCommands';

// ─── Counter commands ───────────────────────────────────────────────────────

export { CounterNotFoundError, getCountersForGuild, getCounterCount, isCounterCommandTaken } from './db/counters';
export { getCounterHistory } from './db/counterArchive';
export { findCounterByCommand } from './db/counterCache';
export {
  addCounter, updateCounter, removeCounter, resetCounterCurrentValue, incrementCounter,
  archiveAndResetYearlyCounters,
} from './db/counterWrites';

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
  getAllEventSubStreamers, getStreamerByDiscordId, getStreamerById, getStreamerByTwitchUserId,
  saveStreamerToken, clearStreamerToken, initEventConfig, saveEventConfig,
  DEFAULT_EVENT_CONFIG,
} from './db/eventSub';
export type { DbStreamerEventSub, EventSubConfig } from './db/eventSub';

// ─── Twitch bot chat OAuth token ────────────────────────────────────────────

export {
  getBotChatToken, saveBotChatTokenIfLatestAttempt, restoreBotChatTokenIfOwnedByConnection,
  saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy,
} from './db/twitchBotAuth';
export type { BotChatToken } from './db/twitchBotAuth';

// ─── Alerts overlay ─────────────────────────────────────────────────────────

export type { AlertEventType, TextAnimation } from './db/alertConfig';
export { ALERT_EVENT_TYPES, ALERT_TEXT_ANIMATIONS } from './db/alertConfig';
export { getAlertConfigsForStreamer, getAlertConfig, getEnabledAlertEventTypesBatch } from './db/alertConfig';
export { findCachedAlertConfig } from './db/alertConfigCache';
export { initAlertConfigs, saveAlertConfig, setAlertImage, setAlertSound } from './db/alertConfigWrites';

// ─── Streamer event log ──────────────────────────────────────────────────────

export type { StreamerEventType, StreamerEvent } from './db/eventLog';
export { recordStreamerEvent, getRecentStreamerEvents } from './db/eventLog';
export type { RedemptionProgress, RedemptionEffect } from './db/redemptionLedger';
export { getRedemptionProgress, markRedemptionEffect, pruneRedemptionLedger, isRedemptionLedgerReady } from './db/redemptionLedger';

// ─── SFX ────────────────────────────────────────────────────────────────────

export type { SfxTrigger, SfxFile, PublicSfxTrigger } from './db/sfx';
export {
  findTrigger, findSoundFiles, getAllSfxTriggers, getSfxTriggerCount, getPublicSfxTriggers,
  getAllCategories, getSfxFileById,
} from './db/sfx';
export type { SfxLookupResult } from './db/sfxCache';
export { findCachedSfxTrigger } from './db/sfxCache';
export {
  createCategory, renameCategory, deleteCategory,
  createSfxTrigger, updateSfxTrigger, deleteSfxTrigger,
  addSfxFile, updateSfxFile, deleteSfxFile,
} from './db/sfxWrites';

// ─── Overlay videos ─────────────────────────────────────────────────────────

export {
  getVideosForStreamer, addVideo, deleteVideo,
  getRewardsForStreamer, saveRewardWithVideos, deleteReward,
  getVideosForReward,
} from './db/overlayVideos';

// ─── Channel point pricing ───────────────────────────────────────────────────

export type { RewardPricingRow, StreamerPricingSettings } from './db/rewardPricing';
export {
  getPricingForReward, getPricingConfigsForStreamer, getAllEnabledPricingRows,
  upsertPricingConfig, recordPricingUpdate, deletePricingConfig, markPricingUnsupported,
  updatePricingCooldownForReward, getPricingSettingsForStreamer, getPricingSettingsForStreamers, savePricingSettingsForStreamer,
  DEFAULT_PRICING_COOLDOWN_SECONDS,
} from './db/rewardPricing';

export { recordPricingHistory, getPricingHistoryForRewards } from './db/rewardPricingHistory';

// ─── Timer commands ─────────────────────────────────────────────────────────

export type {
  DbTimerCommand, DbTimerCommandAssignedUser, DbTimerCommandWithAssignments,
  TimerCommandInput, TimerCommandForScheduler,
} from './db/timerCommands';
export {
  TimerCommandNotFoundError, TimerSelfServiceDeniedError,
  updateOwnTimerCommand, setOwnTimerCommandEnabled, removeOwnTimerCommand, discardOwnNewTimerCommand,
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

export {
  issueToken,
  findDiscordIdByTokenHash,
  getTokenStatus,
  revokeToken,
} from './db/companionTokens';
export { createCode, exchangeCodeForToken } from './db/companionOAuthCodes';

// ─── Passkeys (WebAuthn) ─────────────────────────────────────────────────────

export {
  listPasskeysForUser,
  listPasskeyDescriptorsForUser,
  findPasskey,
  insertPasskey,
  recordPasskeyUse,
  deletePasskey,
} from './db/webauthnCredentials';
export type { PasskeySummary, StoredPasskey, NewPasskey, InsertPasskeyResult } from './db/webauthnCredentials';
export { saveWebauthnChallenge, consumeWebauthnChallenge } from './db/webauthnChallenges';
export type { WebauthnChallengePurpose } from './db/webauthnChallenges';
export {
  savePasskeyEnrollmentCode,
  consumePasskeyEnrollmentCode,
  deletePasskeyEnrollmentCode,
} from './db/passkeyEnrollmentCodes';
export type { EnrollmentCodeResult } from './db/passkeyEnrollmentCodes';
