import mysql from 'mysql2/promise';
import { normalizeTwitchChannelName } from './twitchChannelName';
import { createManagedLookupCache, type RefreshingLookupCache } from './db/lookupCache';
import { getPool } from './db/pool';
export type { RefreshingLookupCache, ManagedLookupCacheOptions, ManagedLookupCache } from './db/lookupCache';
export { getPool, closePool } from './db/pool';

/** Coerces a MySQL BIT(1) or TINYINT(1) column to a boolean. */
function mapBoolColumn(value: unknown): boolean {
  return Buffer.isBuffer(value) ? value[0] === 1 : value == 1;
}

export interface SfxTrigger {
  id: bigint;
  trigger_command: string;
  category_id: number | null;
  hidden: boolean;
  description: string | null;
}

export interface SfxFile {
  id: number;
  trigger_id: bigint;
  file: string;
  trigger_command: string | null;
  weight: number;
  hidden: boolean;
  category_id: number | null;
}

/**
 * Look up a trigger by its command string (case-insensitive).
 * Hidden triggers ARE included — the hidden flag only affects public listing, not playback.
 */
export async function findTrigger(command: string): Promise<SfxTrigger | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_command, category_id, hidden, description
     FROM sfxtrigger
     WHERE LOWER(trigger_command) = ?`,
    [command.toLowerCase()],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: BigInt(row.id),
    trigger_command: row.trigger_command,
    category_id: row.category_id,
    hidden: mapBoolColumn(row.hidden),
    description: row.description,
  };
}

/**
 * Return all sound files associated with a trigger (including hidden ones).
 * Hidden files are still played — `hidden` only controls public listing.
 */
export async function findSoundFiles(triggerId: bigint): Promise<SfxFile[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_id, file, trigger_command, weight, hidden, category_id
     FROM sfx
     WHERE trigger_id = ?`,
    [triggerId.toString()],
  );
  return rows.map((row) => ({
    id: row.id,
    trigger_id: BigInt(row.trigger_id),
    file: row.file,
    trigger_command: row.trigger_command,
    weight: row.weight,
    hidden: mapBoolColumn(row.hidden),
    category_id: row.category_id,
  }));
}

// ─── User / access-level ────────────────────────────────────────────────────

import {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUserByTwitchName, getAllUsers,
  updateDiscordName, getTwitchEnabledChannels, updateAccessLevel,
  upsertUserRecord, setTwitchBotEnabledRecord, removeUserRecord,
} from './db/users';
import type { AccessLevelValue, DbUser } from './db/users';
export {
  AccessLevel, ACCESS_LEVEL_LABELS,
  findUser, findUserByTwitchName, getAllUsers,
  updateDiscordName, getTwitchEnabledChannels, updateAccessLevel,
};
export type { AccessLevelValue, DbUser };

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

export interface DbCustomCommand {
  command_id: number;
  trigger_string: string;
  output: string;
  is_discord_enabled: boolean;
  is_multi_twitch: boolean;
}

export interface DbCustomCommandAssignedUser {
  discord_id: string;
  discord_name: string | null;
  twitch_name: string | null;
  access_level: AccessLevelValue;
  is_twitch_bot_enabled: boolean;
  is_orphaned_user: boolean;
}

export interface DbCustomCommandWithAssignments extends DbCustomCommand {
  assigned_users: DbCustomCommandAssignedUser[];
}

interface CustomCommandLookupCache extends RefreshingLookupCache {
  discordByTrigger: Map<string, DbCustomCommand>;
  twitchByChannelAndTrigger: Map<string, DbCustomCommand>;
}

interface TwitchCommandCandidate {
  command: DbCustomCommand;
  source: 'assigned' | 'multi';
  priority: number;
  owner: string;
}

interface TwitchCandidateContext {
  candidateByCacheKey: Map<string, TwitchCommandCandidate>;
}

function createEmptyCustomCommandLookupCache(): CustomCommandLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    discordByTrigger: new Map<string, DbCustomCommand>(),
    twitchByChannelAndTrigger: new Map<string, DbCustomCommand>(),
  };
}

const CUSTOM_COMMAND_CACHE_TTL_MS = 300_000;
const CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

function mapCustomCommand(row: mysql.RowDataPacket): DbCustomCommand {
  return {
    command_id: row.command_id,
    trigger_string: row.trigger_string,
    output: row.output,
    is_discord_enabled: mapBoolColumn(row.is_discord_enabled),
    is_multi_twitch: mapBoolColumn(row.is_multi_twitch),
  };
}

export async function getAllCustomCommandsWithAssignments(): Promise<DbCustomCommandWithAssignments[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT c.command_id, c.trigger_string, c.output, c.is_discord_enabled, c.is_multi_twitch,
            tuc.discord_id AS assigned_discord_id,
            u.discord_id AS user_discord_id,
            u.discord_name, u.twitch_name, u.access_level, u.is_twitch_bot_enabled
     FROM custom_command c
     LEFT JOIN twitch_user_commands tuc ON c.command_id = tuc.command_id
     LEFT JOIN \`user\` u ON tuc.discord_id = u.discord_id
     ORDER BY c.trigger_string, u.discord_name, tuc.discord_id`,
  );

  const commandMap = new Map<number, DbCustomCommandWithAssignments>();

  for (const row of rows) {
    if (!commandMap.has(row.command_id)) {
      commandMap.set(row.command_id, {
        ...mapCustomCommand(row),
        assigned_users: [],
      });
    }

    if (row.assigned_discord_id !== null && row.assigned_discord_id !== undefined) {
      commandMap.get(row.command_id)!.assigned_users.push({
        discord_id: String(row.assigned_discord_id),
        discord_name: row.discord_name ?? null,
        twitch_name: row.twitch_name ?? null,
        access_level: row.access_level ?? AccessLevel.USER,
        is_twitch_bot_enabled: mapBoolColumn(row.is_twitch_bot_enabled),
        is_orphaned_user: row.user_discord_id === null || row.user_discord_id === undefined,
      });
    }
  }

  return Array.from(commandMap.values());
}

function toDbCustomCommand(command: DbCustomCommandWithAssignments): DbCustomCommand {
  return {
    command_id: command.command_id,
    trigger_string: command.trigger_string,
    output: command.output,
    is_discord_enabled: command.is_discord_enabled,
    is_multi_twitch: command.is_multi_twitch,
  };
}

function cloneDbCustomCommand(command: DbCustomCommand): DbCustomCommand {
  return { ...command };
}

function getTwitchCommandCacheKey(channelName: string, triggerString: string): string | null {
  const normalizedChannelName = normalizeTwitchChannelName(channelName);
  const normalizedTriggerString = triggerString.trim().toLowerCase();

  if (!normalizedChannelName || !normalizedTriggerString) {
    return null;
  }

  return `${normalizedChannelName}::${normalizedTriggerString}`;
}

function normalizeActiveTwitchChannels(activeTwitchChannels: string[]): string[] {
  return activeTwitchChannels
    .map((channel) => normalizeTwitchChannelName(channel))
    .filter((channel): channel is string => channel !== null);
}

function pickPreferredTwitchCandidate(
  existingCandidate: TwitchCommandCandidate,
  nextCandidate: TwitchCommandCandidate,
): TwitchCommandCandidate {
  if (nextCandidate.command.command_id === existingCandidate.command.command_id) {
    return existingCandidate;
  }

  if (nextCandidate.priority !== existingCandidate.priority) {
    return nextCandidate.priority > existingCandidate.priority ? nextCandidate : existingCandidate;
  }

  return nextCandidate.command.command_id < existingCandidate.command.command_id
    ? nextCandidate
    : existingCandidate;
}

function registerDiscordCommand(
  discordByTrigger: Map<string, DbCustomCommand>,
  triggerString: string,
  command: DbCustomCommand,
): void {
  if (!command.is_discord_enabled) {
    return;
  }

  const existingCommand = discordByTrigger.get(triggerString);
  if (existingCommand) {
    console.warn(`[DB] Custom command Discord trigger collision: '${triggerString}' is already registered (command_id=${existingCommand.command_id}); ignoring duplicate from command_id=${command.command_id}.`);
    return;
  }

  discordByTrigger.set(triggerString, command);
}

function registerTwitchCandidate(
  context: TwitchCandidateContext,
  cacheKey: string,
  triggerString: string,
  channelName: string,
  candidate: TwitchCommandCandidate,
): void {
  const existingCandidate = context.candidateByCacheKey.get(cacheKey);
  if (!existingCandidate) {
    context.candidateByCacheKey.set(cacheKey, candidate);
    return;
  }

  const preferredCandidate = pickPreferredTwitchCandidate(existingCandidate, candidate);
  if (preferredCandidate === existingCandidate) {
    if (existingCandidate.command.command_id === candidate.command.command_id) {
      return;
    }

    console.warn(
      `[DB] Custom command Twitch trigger collision: '${triggerString}' in channel '${channelName}' already maps to command_id=${existingCandidate.command.command_id} (${existingCandidate.source}:${existingCandidate.owner}); ignoring command_id=${candidate.command.command_id} (${candidate.source}:${candidate.owner}).`,
    );
    return;
  }

  const logOverride = existingCandidate.priority === candidate.priority
    ? console.warn
    : console.info;
  logOverride(
    `[DB] Custom command Twitch trigger collision: '${triggerString}' in channel '${channelName}' remapped from command_id=${existingCandidate.command.command_id} (${existingCandidate.source}:${existingCandidate.owner}) to command_id=${candidate.command.command_id} (${candidate.source}:${candidate.owner}).`,
  );
  context.candidateByCacheKey.set(cacheKey, preferredCandidate);
}

function registerMultiTwitchCandidates(
  context: TwitchCandidateContext,
  activeChannels: string[],
  triggerString: string,
  command: DbCustomCommand,
  isMultiTwitch: boolean,
): void {
  if (!isMultiTwitch) {
    return;
  }

  for (const activeChannel of activeChannels) {
    const cacheKey = getTwitchCommandCacheKey(activeChannel, triggerString);
    if (!cacheKey) {
      continue;
    }

    registerTwitchCandidate(context, cacheKey, triggerString, activeChannel, {
      command,
      source: 'multi',
      priority: 1,
      owner: 'multi_twitch',
    });
  }
}

function registerAssignedTwitchCandidates(
  context: TwitchCandidateContext,
  assignedUsers: DbCustomCommandAssignedUser[],
  triggerString: string,
  command: DbCustomCommand,
): void {
  for (const assignedUser of assignedUsers) {
    if (!assignedUser.twitch_name || !assignedUser.is_twitch_bot_enabled) {
      continue;
    }

    const cacheKey = getTwitchCommandCacheKey(assignedUser.twitch_name, triggerString);
    if (!cacheKey) {
      continue;
    }

    registerTwitchCandidate(context, cacheKey, triggerString, assignedUser.twitch_name, {
      command,
      source: 'assigned',
      priority: 2,
      owner: assignedUser.discord_id,
    });
  }
}

function buildTwitchCommandLookup(
  candidateByCacheKey: Map<string, TwitchCommandCandidate>,
): Map<string, DbCustomCommand> {
  const twitchByChannelAndTrigger = new Map<string, DbCustomCommand>();
  for (const [cacheKey, candidate] of candidateByCacheKey.entries()) {
    twitchByChannelAndTrigger.set(cacheKey, candidate.command);
  }
  return twitchByChannelAndTrigger;
}

function buildCustomCommandLookupCache(
  commands: DbCustomCommandWithAssignments[],
  activeTwitchChannels: string[],
): CustomCommandLookupCache {
  const discordByTrigger = new Map<string, DbCustomCommand>();
  const twitchCandidateByChannelAndTrigger = new Map<string, TwitchCommandCandidate>();
  const sortedCommands = [...commands].sort((left, right) => left.command_id - right.command_id);
  const normalizedActiveTwitchChannels = normalizeActiveTwitchChannels(activeTwitchChannels);
  const twitchCandidateContext: TwitchCandidateContext = {
    candidateByCacheKey: twitchCandidateByChannelAndTrigger,
  };

  for (const command of sortedCommands) {
    const normalizedTriggerString = command.trigger_string.trim().toLowerCase();
    if (!normalizedTriggerString) {
      continue;
    }

    const baseCommand = toDbCustomCommand(command);

    registerDiscordCommand(discordByTrigger, normalizedTriggerString, baseCommand);
    registerMultiTwitchCandidates(
      twitchCandidateContext,
      normalizedActiveTwitchChannels,
      normalizedTriggerString,
      baseCommand,
      command.is_multi_twitch,
    );
    registerAssignedTwitchCandidates(
      twitchCandidateContext,
      command.assigned_users,
      normalizedTriggerString,
      baseCommand,
    );
  }

  return {
    loadedAt: Date.now(),
    discordByTrigger,
    twitchByChannelAndTrigger: buildTwitchCommandLookup(twitchCandidateByChannelAndTrigger),
  };
}

const customCommandLookupCacheState = createManagedLookupCache<CustomCommandLookupCache>({
  cacheName: 'custom command cache',
  ttlMs: CUSTOM_COMMAND_CACHE_TTL_MS,
  refreshFailureBackoffMs: CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCustomCommandLookupCache,
  loadCache: async () => {
    const [commands, activeTwitchChannels] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getTwitchEnabledChannels(),
    ]);

    return buildCustomCommandLookupCache(commands, activeTwitchChannels);
  },
});

async function getCustomCommandLookupCache(): Promise<CustomCommandLookupCache> {
  return await customCommandLookupCacheState.getCache();
}

export function invalidateCustomCommandLookupCache(): void {
  customCommandLookupCacheState.invalidate();
}

export async function getCustomCommandForTwitchChannel(channelName: string, triggerString: string): Promise<DbCustomCommand | null> {
  const cacheKey = getTwitchCommandCacheKey(channelName, triggerString);
  if (!cacheKey) {
    return null;
  }

  const cache = await getCustomCommandLookupCache();
  const cachedCommand = cache.twitchByChannelAndTrigger.get(cacheKey);
  return cachedCommand ? cloneDbCustomCommand(cachedCommand) : null;
}

export async function getCustomCommandForDiscord(triggerString: string): Promise<DbCustomCommand | null> {
  const normalizedTriggerString = triggerString.trim().toLowerCase();
  if (!normalizedTriggerString) {
    return null;
  }

  const cache = await getCustomCommandLookupCache();
  const cachedCommand = cache.discordByTrigger.get(normalizedTriggerString);
  return cachedCommand ? cloneDbCustomCommand(cachedCommand) : null;
}

import {
  requireTrimmedString, normalizeCommandList, normalizeCommandInputs,
  isAnyCommandTakenAcrossTables, isCustomCommandTriggerTaken,
  assertDiscordTriggerAvailable, assertMultiTwitchTriggerAvailable, assertNoSingleTwitchAssignmentOverlap,
  getCommandWriteLockName, acquireNamedLock, releaseNamedLock,
  getCommandTriggerStringById, getUserTwitchEligibility,
  assertNoTwitchChannelTriggerConflict, insertUserCommandAssignment,
  assignUserToCommandWithinTransaction, commandExists, runSerializedCommandWrite,
  CommandNotFoundError,
} from './db/commandLocks';
import type { SqlExecutor } from './db/commandLocks';
export {
  CommandNotFoundError, CommandConflictError, isMysqlDuplicateEntryError,
  isCustomCommandTriggerTaken,
} from './db/commandLocks';
export type { SqlExecutor } from './db/commandLocks';

export async function addCustomCommand(
  triggerString: string,
  output: string,
  isDiscordEnabled: boolean,
  isMultiTwitch: boolean,
): Promise<void> {
  const normalizedTriggerString = requireTrimmedString(triggerString, 'trigger_string').toLowerCase();
  const normalizedOutput = requireTrimmedString(output, 'output');

  await runSerializedCommandWrite(
    normalizedTriggerString,
    undefined,
    async (connection) => {
      if (isDiscordEnabled) {
        await assertDiscordTriggerAvailable(normalizedTriggerString, connection);
      }

      if (isMultiTwitch) {
        await assertMultiTwitchTriggerAvailable(connection, normalizedTriggerString);
      }

      await connection.execute(
      `INSERT INTO custom_command (trigger_string, output, is_discord_enabled, is_multi_twitch)
       VALUES (?, ?, ?, ?)`,
      [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0],
      );
    },
    { includeCustomCommandTable: false, includeCounterTable: true },
  );

  invalidateCustomCommandLookupCache();
}

export async function updateCustomCommand(
  commandId: number,
  triggerString: string,
  output: string,
  isDiscordEnabled: boolean,
  isMultiTwitch: boolean,
): Promise<void> {
  const normalizedTriggerString = requireTrimmedString(triggerString, 'trigger_string').toLowerCase();
  const normalizedOutput = requireTrimmedString(output, 'output');

  await runSerializedCommandWrite(
    normalizedTriggerString,
    { excludeCustomCommandId: commandId },
    async (connection) => {
      if (isDiscordEnabled) {
        await assertDiscordTriggerAvailable(normalizedTriggerString, connection, commandId);
      }

      if (isMultiTwitch) {
        await assertMultiTwitchTriggerAvailable(connection, normalizedTriggerString, commandId);
      } else {
        await assertNoSingleTwitchAssignmentOverlap(connection, commandId, normalizedTriggerString);
      }

      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE custom_command
         SET trigger_string = ?, output = ?, is_discord_enabled = ?, is_multi_twitch = ?
         WHERE command_id = ?`,
        [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0, commandId],
      );

      if (result.affectedRows === 0 && !(await commandExists(commandId, connection))) {
        throw new CommandNotFoundError(commandId);
      }
    },
    { includeCustomCommandTable: false, includeCounterTable: true },
  );

  invalidateCustomCommandLookupCache();
}

export async function removeCustomCommand(commandId: number): Promise<void> {
  const connection = await getPool().getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM twitch_user_commands WHERE command_id = ?',
      [commandId],
    );
    await connection.execute(
      'DELETE FROM custom_command WHERE command_id = ?',
      [commandId],
    );
    await connection.commit();
    // Invalidate only after a successful commit; refresh remains lazy on next lookup.
    invalidateCustomCommandLookupCache();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function assignUserToCommand(commandId: number, discordId: string): Promise<void> {
  const connection = await getPool().getConnection();

  const lockNameById = `bcuk_cmdid_${commandId}`;
  try {
    // The outer assignUserToCommand lock serializes writes for one command id.
    // assignUserToCommandWithinTransaction then re-reads the trigger via
    // getCommandTriggerStringById, derives lockNameByTrigger, and acquires the
    // session-scoped trigger lock so cross-command trigger conflicts are checked
    // against the latest trigger string before inserting the assignment.
    await acquireNamedLock(connection, lockNameById);

    await assignUserToCommandWithinTransaction(connection, commandId, discordId);

    // Invalidate only after commit; keep lock ownership and connection lifecycle deterministic.
    invalidateCustomCommandLookupCache();
  } finally {
    // Always release the id lock
    await releaseNamedLock(connection, lockNameById);
    connection.release();
  }
}

export async function unassignUserFromCommand(commandId: number, discordId: string): Promise<void> {
  await getPool().execute(
    'DELETE FROM twitch_user_commands WHERE command_id = ? AND discord_id = ?',
    [commandId, discordId],
  );

  invalidateCustomCommandLookupCache();
}

// ─── Counter commands ───────────────────────────────────────────────────────

export interface DbCounter {
  id: number;
  trigger_command: string;
  check_command: string;
  message: string;
  increment_message: string;
  reset_yearly: boolean;
  current_value: number;
}

export type CounterMatchType = 'trigger' | 'check';

export interface DbMatchedCounter extends DbCounter {
  matchType: CounterMatchType;
}

export class CounterNotFoundError extends Error {
  constructor(id: number) {
    super(`Counter not found: ${id}`);
    this.name = 'CounterNotFoundError';
  }
}

interface NormalizedCounterFields {
  triggerCommand: string;
  checkCommand: string;
  message: string;
  incrementMessage: string;
}

export interface UpdateCounterInput {
  id: number;
  triggerCommand: string;
  checkCommand: string;
  message: string;
  incrementMessage: string;
  resetYearly: boolean;
}

function normalizeCounterFields(
  triggerCommand: string,
  checkCommand: string,
  message: string,
  incrementMessage: string,
): NormalizedCounterFields {
  return {
    triggerCommand: requireTrimmedString(triggerCommand, 'trigger_command').toLowerCase(),
    checkCommand: requireTrimmedString(checkCommand, 'check_command').toLowerCase(),
    message: requireTrimmedString(message, 'message'),
    incrementMessage: requireTrimmedString(incrementMessage, 'increment_message'),
  };
}

function mapCounter(row: mysql.RowDataPacket): DbCounter {
  return {
    id: row.id,
    trigger_command: row.trigger_command,
    check_command: row.check_command,
    message: row.message,
    increment_message: row.increment_message,
    reset_yearly: mapBoolColumn(row.reset_yearly),
    current_value: row.current_value,
  };
}

interface CounterLookupCache extends RefreshingLookupCache {
  byCommand: Map<string, DbMatchedCounter>;
}

function createEmptyCounterLookupCache(): CounterLookupCache {
  return {
    // Keep the fallback cache immediately stale so a new refresh can start as soon
    // as the backoff window expires rather than waiting for the normal TTL.
    loadedAt: 0,
    byCommand: new Map<string, DbMatchedCounter>(),
  };
}

const COUNTER_LOOKUP_CACHE_TTL_MS = 300_000;
const COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

function buildCounterLookupCache(counters: DbCounter[]): CounterLookupCache {
  const byCommand = new Map<string, DbMatchedCounter>();
  const sortedCounters = [...counters].sort((left, right) => left.id - right.id);

  const registerCounterCommand = (
    normalizedCommand: string,
    counter: DbCounter,
    matchType: CounterMatchType,
    commandFieldLabel: 'trigger_command' | 'check_command',
  ): void => {
    if (!normalizedCommand) {
      return;
    }

    const existingCounter = byCommand.get(normalizedCommand);
    if (existingCounter) {
      console.warn(`[DB] Counter ${commandFieldLabel} collision: '${normalizedCommand}' is already registered (counter id=${existingCounter.id}); ignoring duplicate from counter id=${counter.id}.`);
      return;
    }

    byCommand.set(normalizedCommand, { ...counter, matchType });
  };

  for (const counter of sortedCounters) {
    registerCounterCommand(counter.trigger_command.trim().toLowerCase(), counter, 'trigger', 'trigger_command');
    registerCounterCommand(counter.check_command.trim().toLowerCase(), counter, 'check', 'check_command');
  }

  return {
    loadedAt: Date.now(),
    byCommand,
  };
}

const counterLookupCacheState = createManagedLookupCache<CounterLookupCache>({
  cacheName: 'counter cache',
  ttlMs: COUNTER_LOOKUP_CACHE_TTL_MS,
  refreshFailureBackoffMs: COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCounterLookupCache,
  loadCache: async () => {
    const counters = await getAllCounters();
    return buildCounterLookupCache(counters);
  },
});

async function getCounterLookupCache(): Promise<CounterLookupCache> {
  return await counterLookupCacheState.getCache();
}

export function invalidateCounterLookupCache(): void {
  counterLookupCacheState.invalidate();
}

export async function getAllCounters(): Promise<DbCounter[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_command, check_command, message, increment_message, reset_yearly, current_value
     FROM counter
     ORDER BY trigger_command`,
  );

  return rows.map(mapCounter);
}

export async function findCounterByCommand(command: string): Promise<DbMatchedCounter | null> {
  const normalizedCommand = command.trim().toLowerCase();
  if (!normalizedCommand) {
    return null;
  }

  const cache = await getCounterLookupCache();
  const counter = cache.byCommand.get(normalizedCommand);

  return counter
    ? {
      ...counter,
    }
    : null;
}

export async function isCounterCommandTaken(commandOrCommands: string | string[], excludeCounterId?: number): Promise<boolean> {
  if (Array.isArray(commandOrCommands)) {
    const normalizedCommands = normalizeCommandList(commandOrCommands);
    if (new Set(normalizedCommands).size !== normalizedCommands.length) {
      return true;
    }
  }

  return await isAnyCommandTakenAcrossTables(commandOrCommands, { excludeCounterId });
}

export async function addCounter(
  triggerCommand: string,
  checkCommand: string,
  message: string,
  incrementMessage: string,
  resetYearly: boolean,
): Promise<void> {
  const normalizedFields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (normalizedFields.triggerCommand === normalizedFields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  await runSerializedCommandWrite(
    [normalizedFields.triggerCommand, normalizedFields.checkCommand],
    undefined,
    async (connection) => {
      await connection.execute(
        `INSERT INTO counter (trigger_command, check_command, message, increment_message, reset_yearly, current_value)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [
          normalizedFields.triggerCommand,
          normalizedFields.checkCommand,
          normalizedFields.message,
          normalizedFields.incrementMessage,
          resetYearly ? 1 : 0,
        ],
      );
    },
  );

  invalidateCounterLookupCache();
}

async function counterExists(id: number, executor: SqlExecutor = getPool()): Promise<boolean> {
  const [rows] = await executor.execute<mysql.RowDataPacket[]>(
    'SELECT 1 FROM counter WHERE id = ? LIMIT 1',
    [id],
  );
  return rows.length > 0;
}

export async function updateCounter(input: UpdateCounterInput): Promise<void> {
  const {
    id,
    triggerCommand,
    checkCommand,
    message,
    incrementMessage,
    resetYearly,
  } = input;

  const normalizedFields = normalizeCounterFields(triggerCommand, checkCommand, message, incrementMessage);
  if (normalizedFields.triggerCommand === normalizedFields.checkCommand) {
    throw new Error('Counter trigger_command and check_command must be different');
  }

  await runSerializedCommandWrite(
    [normalizedFields.triggerCommand, normalizedFields.checkCommand],
    { excludeCounterId: id },
    async (connection) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE counter
         SET trigger_command = ?,
             check_command = ?,
             message = ?,
             increment_message = ?,
             reset_yearly = ?
         WHERE id = ?`,
        [
          normalizedFields.triggerCommand,
          normalizedFields.checkCommand,
          normalizedFields.message,
          normalizedFields.incrementMessage,
          resetYearly ? 1 : 0,
          id,
        ],
      );

      if (result.affectedRows === 0 && !(await counterExists(id, connection))) {
        throw new CounterNotFoundError(id);
      }
    },
  );

  invalidateCounterLookupCache();
}

export async function removeCounter(id: number): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>('DELETE FROM counter WHERE id = ?', [id]);
  if (result.affectedRows === 0) {
    throw new CounterNotFoundError(id);
  }

  invalidateCounterLookupCache();
}

export async function resetCounterCurrentValue(id: number): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'UPDATE counter SET current_value = 0 WHERE id = ?',
    [id],
  );

  if (result.affectedRows === 0 && !(await counterExists(id))) {
    throw new CounterNotFoundError(id);
  }

  invalidateCounterLookupCache();
}

export async function incrementCounter(id: number): Promise<number> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      'UPDATE counter SET current_value = current_value + 1 WHERE id = ?',
      [id],
    );
    if (result.affectedRows === 0) throw new CounterNotFoundError(id);
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT current_value FROM counter WHERE id = ?',
      [id],
    );
    const newValue = (rows[0] as mysql.RowDataPacket).current_value as number;
    await conn.commit();
    invalidateCounterLookupCache();
    return newValue;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function archiveAndResetYearlyCounters(year: number): Promise<number> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error(`[DB] Invalid archive year: ${year}`);
  }
  // MySQL doesn't support parameterised column names, so the name is built from
  // `year` which is validated to a safe integer in [2020, 2100] above.
  const columnName = `value${year}`;
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE counter SET \`${columnName}\` = current_value, current_value = 0 WHERE reset_yearly = 1 AND \`${columnName}\` IS NULL`,
  );
  invalidateCounterLookupCache();
  return result.affectedRows;
}

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

// ─── SFX dashboard data ─────────────────────────────────────────────────────

export interface SfxTriggerRow {
  triggerId: number;
  triggerCommand: string;
  description: string | null;
  hidden: boolean;
  categoryName: string | null;
  files: Array<{ id: number; file: string; weight: number; hidden: boolean }>;
}

export async function getAllSfxTriggers(): Promise<SfxTriggerRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT
       t.id          AS triggerId,
       t.trigger_command AS triggerCommand,
       t.description,
       t.hidden      AS triggerHidden,
       c.name        AS categoryName,
       s.id          AS sfxId,
       s.file,
       s.weight,
       s.hidden      AS sfxHidden
     FROM sfxtrigger t
     LEFT JOIN sfxcategory c ON t.category_id = c.id
     LEFT JOIN sfx s ON s.trigger_id = t.id
     ORDER BY c.name, t.trigger_command, s.id`,
  );

  const map = new Map<number, SfxTriggerRow>();
  for (const r of rows) {
    if (!map.has(r.triggerId)) {
      map.set(r.triggerId, {
        triggerId: r.triggerId,
        triggerCommand: r.triggerCommand,
        description: r.description ?? null,
        hidden: mapBoolColumn(r.triggerHidden),
        categoryName: r.categoryName ?? null,
        files: [],
      });
    }
    if (r.sfxId !== null) {
      map.get(r.triggerId)!.files.push({
        id: r.sfxId,
        file: r.file,
        weight: r.weight,
        hidden: mapBoolColumn(r.sfxHidden),
      });
    }
  }
  return Array.from(map.values());
}
