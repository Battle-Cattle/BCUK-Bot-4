import mysql from 'mysql2/promise';
import { normalizeTwitchChannelName } from '../twitchChannelName';
import { getPool } from './pool';
import { createManagedLookupCache, type RefreshingLookupCache } from './lookupCache';
import { AccessLevel, getTwitchEnabledChannels } from './users';
import type { AccessLevelValue } from './users';
import {
  requireTrimmedString,
  assertDiscordTriggerAvailable, assertMultiTwitchTriggerAvailable, assertNoSingleTwitchAssignmentOverlap,
  getCommandWriteLockName, acquireNamedLock, releaseNamedLock,
  assignUserToCommandWithinTransaction, commandExists, runSerializedCommandWrite,
  CommandNotFoundError,
} from './commandLocks';
import type { SqlExecutor } from './commandLocks';

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Row mappers ─────────────────────────────────────────────────────────────

function mapBool(value: unknown): boolean {
  return Buffer.isBuffer(value) ? value[0] === 1 : value == 1;
}

function mapCustomCommand(row: mysql.RowDataPacket): DbCustomCommand {
  return {
    command_id: row.command_id,
    trigger_string: row.trigger_string,
    output: row.output,
    is_discord_enabled: mapBool(row.is_discord_enabled),
    is_multi_twitch: mapBool(row.is_multi_twitch),
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

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
        is_twitch_bot_enabled: mapBool(row.is_twitch_bot_enabled),
        is_orphaned_user: row.user_discord_id === null || row.user_discord_id === undefined,
      });
    }
  }

  return Array.from(commandMap.values());
}

// ─── Lookup cache ─────────────────────────────────────────────────────────────

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

    const baseCommand = {
      command_id: command.command_id,
      trigger_string: command.trigger_string,
      output: command.output,
      is_discord_enabled: command.is_discord_enabled,
      is_multi_twitch: command.is_multi_twitch,
    };

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

  const twitchByChannelAndTrigger = new Map<string, DbCustomCommand>();
  for (const [cacheKey, candidate] of twitchCandidateByChannelAndTrigger.entries()) {
    twitchByChannelAndTrigger.set(cacheKey, candidate.command);
  }

  return {
    loadedAt: Date.now(),
    discordByTrigger,
    twitchByChannelAndTrigger,
  };
}

const CACHE_TTL_MS = 300_000;
const CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

const customCommandLookupCacheState = createManagedLookupCache<CustomCommandLookupCache>({
  cacheName: 'custom command cache',
  ttlMs: CACHE_TTL_MS,
  refreshFailureBackoffMs: CACHE_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCustomCommandLookupCache,
  loadCache: async () => {
    const [commands, activeTwitchChannels] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getTwitchEnabledChannels(),
    ]);
    return buildCustomCommandLookupCache(commands, activeTwitchChannels);
  },
});

export function invalidateCustomCommandLookupCache(): void {
  customCommandLookupCacheState.invalidate();
}

export async function getCustomCommandForTwitchChannel(channelName: string, triggerString: string): Promise<DbCustomCommand | null> {
  const cacheKey = getTwitchCommandCacheKey(channelName, triggerString);
  if (!cacheKey) {
    return null;
  }

  const cache = await customCommandLookupCacheState.getCache();
  const cachedCommand = cache.twitchByChannelAndTrigger.get(cacheKey);
  return cachedCommand ? { ...cachedCommand } : null;
}

export async function getCustomCommandForDiscord(triggerString: string): Promise<DbCustomCommand | null> {
  const normalizedTriggerString = triggerString.trim().toLowerCase();
  if (!normalizedTriggerString) {
    return null;
  }

  const cache = await customCommandLookupCacheState.getCache();
  const cachedCommand = cache.discordByTrigger.get(normalizedTriggerString);
  return cachedCommand ? { ...cachedCommand } : null;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

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
    const [result] = await connection.execute<mysql.ResultSetHeader>(
      'DELETE FROM custom_command WHERE command_id = ?',
      [commandId],
    );
    if (result.affectedRows === 0) {
      throw new CommandNotFoundError(commandId);
    }
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

// Unused in this module but exported so commandLocks.ts helpers remain type-safe
// when callers import SqlExecutor from db.ts for their own executors.
export type { SqlExecutor };
