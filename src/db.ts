import mysql from 'mysql2/promise';
import { createManagedLookupCache, type RefreshingLookupCache } from './db/lookupCache';
import { getPool } from './db/pool';
import {
  requireTrimmedString, normalizeCommandList, isAnyCommandTakenAcrossTables,
  runSerializedCommandWrite,
} from './db/commandLocks';
import type { SqlExecutor } from './db/commandLocks';
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
export type { SqlExecutor } from './db/commandLocks';

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
