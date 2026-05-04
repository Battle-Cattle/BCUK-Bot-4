import mysql from 'mysql2/promise';
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
