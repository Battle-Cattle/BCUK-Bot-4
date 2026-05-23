export type { RefreshingLookupCache, ManagedLookupCacheOptions, ManagedLookupCache } from './db/lookupCache';
export { getPool, closePool } from './db/pool';

// ─── User / access-level ────────────────────────────────────────────────────

export {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUserByTwitchName, getAllUsers,
  updateDiscordName, getTwitchEnabledChannels, updateAccessLevel,
} from './db/users';
export type { AccessLevelValue, DbUser } from './db/users';

import { upsertUserRecord, setTwitchBotEnabledRecord, removeUserRecord } from './db/users';

// Wrappers add cache invalidation — users.ts is a pure DB layer with no cache knowledge.

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

export async function updateTwitchBotEnabled(discordId: string, enabled: boolean): Promise<void> {
  await setTwitchBotEnabledRecord(discordId, enabled);
  invalidateCustomCommandLookupCache();
}

export async function removeUser(discordId: string): Promise<void> {
  await removeUserRecord(discordId);
  invalidateCustomCommandLookupCache();
}

// ─── Custom commands ────────────────────────────────────────────────────────

import { invalidateCustomCommandLookupCache } from './db/customCommands';
export {
  getAllCustomCommandsWithAssignments,
  invalidateCustomCommandLookupCache,
  getCustomCommandForTwitchChannel, getCustomCommandForDiscord,
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  assignUserToCommand, unassignUserFromCommand,
} from './db/customCommands';
export type {
  DbCustomCommand, DbCustomCommandAssignedUser, DbCustomCommandWithAssignments,
} from './db/customCommands';
export {
  CommandNotFoundError, CommandConflictError, isMysqlDuplicateEntryError,
  isCustomCommandTriggerTaken,
} from './db/commandLocks';
export { ReservedCommandError, RESERVED_BUILT_IN_COMMANDS } from './db/reservedCommands';
export type { SqlExecutor } from './db/commandLocks';

// ─── Counter commands ───────────────────────────────────────────────────────

export {
  CounterNotFoundError, invalidateCounterLookupCache,
  getAllCounters, findCounterByCommand, isCounterCommandTaken,
  addCounter, updateCounter, removeCounter, resetCounterCurrentValue,
  incrementCounter, archiveAndResetYearlyCounters,
} from './db/counters';
export type { DbCounter, CounterMatchType, DbMatchedCounter, UpdateCounterInput } from './db/counters';

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
  saveStreamerToken, clearStreamerToken, saveEventConfig,
} from './db/eventSub';
export type { DbStreamerEventSub, EventSubConfig } from './db/eventSub';

// ─── SFX ────────────────────────────────────────────────────────────────────

export type { SfxTrigger, SfxFile, SfxTriggerRow, PublicSfxTrigger } from './db/sfx';
export { findTrigger, findSoundFiles, getAllSfxTriggers, getPublicSfxTriggers } from './db/sfx';

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
