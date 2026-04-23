import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from './config';
import { normalizeTwitchChannelName } from './twitchChannelName';

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

let pool: mysql.Pool | undefined;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      supportBigNumbers: true,
      bigNumberStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10_000,
    });
  }
  return pool!;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
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
    hidden: Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden == 1,
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
    hidden: Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden == 1,
    category_id: row.category_id,
  }));
}

// ─── User / access-level ────────────────────────────────────────────────────

export const AccessLevel = {
  USER: 0,
  MOD: 1,
  MANAGER: 2,
  ADMIN: 3,
} as const;

export type AccessLevelValue = (typeof AccessLevel)[keyof typeof AccessLevel];

export const ACCESS_LEVEL_LABELS: Record<number, string> = {
  0: 'User',
  1: 'Mod',
  2: 'Manager',
  3: 'Admin',
};

export interface DbUser {
  discord_id: string;
  discord_name: string | null;
  is_twitch_bot_enabled: boolean;
  twitch_name: string | null;
  access_level: number;
}

export async function findUser(discordId: string): Promise<DbUser | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level FROM `user` WHERE discord_id = ?',
    [discordId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    discord_id: String(r.discord_id),
    discord_name: r.discord_name,
    is_twitch_bot_enabled: Buffer.isBuffer(r.is_twitch_bot_enabled) ? r.is_twitch_bot_enabled[0] === 1 : r.is_twitch_bot_enabled == 1,
    twitch_name: r.twitch_name,
    access_level: r.access_level,
  };
}

export async function findUserByTwitchName(twitchName: string, excludeDiscordId?: string): Promise<DbUser | null> {
  const normalizedTwitchName = normalizeTwitchChannelName(twitchName);
  if (!normalizedTwitchName) {
    return null;
  }

  const sql = excludeDiscordId
    ? `SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level
       FROM \`user\`
       WHERE twitch_name = ?
         AND discord_id <> ?
       LIMIT 1`
    : `SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level
       FROM \`user\`
       WHERE twitch_name = ?
       LIMIT 1`;
  const params = excludeDiscordId
    ? [normalizedTwitchName, excludeDiscordId]
    : [normalizedTwitchName];
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(sql, params);

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    discord_id: String(r.discord_id),
    discord_name: r.discord_name,
    is_twitch_bot_enabled: Buffer.isBuffer(r.is_twitch_bot_enabled) ? r.is_twitch_bot_enabled[0] === 1 : r.is_twitch_bot_enabled == 1,
    twitch_name: r.twitch_name,
    access_level: r.access_level,
  };
}

export async function getAllUsers(): Promise<DbUser[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT discord_id, discord_name, is_twitch_bot_enabled, twitch_name, access_level FROM `user` ORDER BY access_level DESC, discord_name ASC',
  );
  return rows.map((r) => ({
    discord_id: String(r.discord_id),
    discord_name: r.discord_name,
    is_twitch_bot_enabled: Buffer.isBuffer(r.is_twitch_bot_enabled) ? r.is_twitch_bot_enabled[0] === 1 : r.is_twitch_bot_enabled == 1,
    twitch_name: r.twitch_name,
    access_level: r.access_level,
  }));
}

export async function upsertUser(
  discordId: string,
  discordName: string,
  accessLevel: number,
  twitchName?: string | null,
): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  const twitchNameProvided = twitchName !== undefined;
  const normalizedTwitchName = !twitchNameProvided
    ? null
    : twitchName === null
      ? null
      : (() => {
          const trimmedTwitchName = twitchName.trim();
          if (!trimmedTwitchName) {
            return null;
          }
          const normalizedChannelName = normalizeTwitchChannelName(trimmedTwitchName);
          if (!normalizedChannelName) {
            throw new Error(`Invalid twitchName: ${twitchName}`);
          }
          return normalizedChannelName;
        })();
  await getPool().execute(
    `INSERT INTO \`user\` (discord_id, discord_name, access_level, twitch_name, is_twitch_bot_enabled)
     VALUES (?, ?, ?, ?, 0) AS new_user
     ON DUPLICATE KEY UPDATE discord_name = new_user.discord_name, access_level = new_user.access_level, twitch_name = IF(?, new_user.twitch_name, \`user\`.twitch_name)`,
    [discordId, discordName, accessLevel, normalizedTwitchName, twitchNameProvided ? 1 : 0],
  );

  if (twitchNameProvided) {
    invalidateCustomCommandLookupCache();
  }
}

export async function updateDiscordName(discordId: string, name: string): Promise<void> {
  await getPool().execute(
    'UPDATE `user` SET discord_name = ? WHERE discord_id = ?',
    [name, discordId],
  );
}

export async function getTwitchEnabledChannels(): Promise<string[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT twitch_name
     FROM \`user\`
     WHERE is_twitch_bot_enabled = 1
       AND twitch_name IS NOT NULL
       AND twitch_name <> ''`,
  );
  return rows
    .map((r) => normalizeTwitchChannelName(String(r.twitch_name)))
    .filter((v): v is string => v !== null);
}

export async function updateTwitchBotEnabled(discordId: string, enabled: boolean): Promise<void> {
  await getPool().execute(
    'UPDATE `user` SET is_twitch_bot_enabled = ? WHERE discord_id = ?',
    [enabled ? 1 : 0, discordId],
  );

  invalidateCustomCommandLookupCache();
}

export async function updateAccessLevel(discordId: string, accessLevel: number): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  await getPool().execute(
    'UPDATE `user` SET access_level = ? WHERE discord_id = ?',
    [accessLevel, discordId],
  );
}

export async function removeUser(discordId: string): Promise<void> {
  await getPool().execute('DELETE FROM `user` WHERE discord_id = ?', [discordId]);

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

interface RefreshingLookupCache {
  loadedAt: number;
}

interface ManagedLookupCacheOptions<TCache extends RefreshingLookupCache> {
  cacheName: string;
  ttlMs: number;
  refreshFailureBackoffMs: number;
  refreshFailureMaxBackoffMs: number;
  createEmptyCache: () => TCache;
  loadCache: () => Promise<TCache>;
}

interface ManagedLookupCache<TCache extends RefreshingLookupCache> {
  getCache: () => Promise<TCache>;
  invalidate: () => void;
}

function createManagedLookupCache<TCache extends RefreshingLookupCache>(
  options: ManagedLookupCacheOptions<TCache>,
): ManagedLookupCache<TCache> {
  let cache: TCache | null = null;
  let inFlightPromise: Promise<TCache> | null = null;
  let version = 0;
  let refreshAllowedAt = 0;
  let refreshFailureCount = 0;

  function getRefreshBackoffMs(): number {
    const backoffMultiplier = 2 ** Math.max(0, refreshFailureCount - 1);
    return Math.min(
      options.refreshFailureBackoffMs * backoffMultiplier,
      options.refreshFailureMaxBackoffMs,
    );
  }

  function refreshInBackground(): void {
    if (inFlightPromise) {
      return;
    }

    const now = Date.now();
    if (now < refreshAllowedAt) {
      return;
    }

    const requestVersion = version;
    inFlightPromise = (async () => {
      const rebuiltCache = await options.loadCache();
      if (requestVersion === version) {
        cache = rebuiltCache;
        refreshAllowedAt = 0;
        refreshFailureCount = 0;
      }
      return rebuiltCache;
    })();

    const promiseForFinally = inFlightPromise;
    void promiseForFinally
      .catch((err) => {
        if (requestVersion !== version) {
          return;
        }

        refreshFailureCount += 1;
        const retryDelayMs = getRefreshBackoffMs();
        refreshAllowedAt = Date.now() + retryDelayMs;

        if (!cache) {
          cache = options.createEmptyCache();
          console.error(`[DB] Background ${options.cacheName} refresh failed; serving an empty cache and retrying after ${retryDelayMs}ms.`, err);
          return;
        }

        console.error(`[DB] Background ${options.cacheName} refresh failed; serving stale cache and retrying after ${retryDelayMs}ms.`, err);
      })
      .finally(() => {
        if (inFlightPromise === promiseForFinally) {
          inFlightPromise = null;
        }
      });
  }

  async function awaitCachePromise(promise: Promise<TCache>): Promise<TCache> {
    try {
      return await promise;
    } catch (err) {
      if (cache) {
        return cache;
      }

      throw err;
    }
  }

  async function getCache(): Promise<TCache> {
    const now = Date.now();

    if (cache) {
      if (now - cache.loadedAt >= options.ttlMs && now >= refreshAllowedAt) {
        refreshInBackground();
      }
      return cache;
    }

    const requestVersion = version;
    refreshInBackground();

    if (!inFlightPromise) {
      if (cache) {
        return cache;
      }

      throw new Error(`${options.cacheName} refresh did not start`);
    }

    const resolvedCache = await awaitCachePromise(inFlightPromise);

    if (requestVersion === version) {
      return resolvedCache;
    }

    if (cache) {
      return cache;
    }

    refreshInBackground();

    if (inFlightPromise) {
      return await awaitCachePromise(inFlightPromise);
    }

    throw new Error(`${options.cacheName} refresh did not start`);
  }

  function invalidate(): void {
    version += 1;
    cache = null;
    inFlightPromise = null;
    refreshAllowedAt = 0;
    refreshFailureCount = 0;
  }

  return {
    getCache,
    invalidate,
  };
}

interface CustomCommandLookupCache extends RefreshingLookupCache {
  discordByTrigger: Map<string, DbCustomCommand>;
  twitchByChannelAndTrigger: Map<string, DbCustomCommand>;
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

const CUSTOM_COMMAND_CACHE_TTL_MS = 15_000;
const CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;
const COMMAND_WRITE_LOCK_TIMEOUT_SECONDS = 10;

type SqlExecutor = mysql.Pool | mysql.PoolConnection;

function mapCustomCommand(row: mysql.RowDataPacket): DbCustomCommand {
  return {
    command_id: row.command_id,
    trigger_string: row.trigger_string,
    output: row.output,
    is_discord_enabled: Buffer.isBuffer(row.is_discord_enabled) ? row.is_discord_enabled[0] === 1 : row.is_discord_enabled == 1,
    is_multi_twitch: Buffer.isBuffer(row.is_multi_twitch) ? row.is_multi_twitch[0] === 1 : row.is_multi_twitch == 1,
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
        is_twitch_bot_enabled: Buffer.isBuffer(row.is_twitch_bot_enabled) ? row.is_twitch_bot_enabled[0] === 1 : row.is_twitch_bot_enabled == 1,
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

function buildCustomCommandLookupCache(
  commands: DbCustomCommandWithAssignments[],
  activeTwitchChannels: string[],
  counterCommands: Set<string>,
): CustomCommandLookupCache {
  const discordByTrigger = new Map<string, DbCustomCommand>();
  const twitchByChannelAndTrigger = new Map<string, DbCustomCommand>();
  const loggedCrossTableCollisions = new Set<string>();
  const sortedCommands = [...commands].sort((left, right) => left.command_id - right.command_id);
  const normalizedActiveTwitchChannels = activeTwitchChannels
    .map((channel) => normalizeTwitchChannelName(channel))
    .filter((channel): channel is string => channel !== null);

  for (const command of sortedCommands) {
    const normalizedTriggerString = command.trigger_string.trim().toLowerCase();
    if (!normalizedTriggerString) {
      continue;
    }

    if (counterCommands.has(normalizedTriggerString) && !loggedCrossTableCollisions.has(normalizedTriggerString)) {
      loggedCrossTableCollisions.add(normalizedTriggerString);
      console.warn(`[DB] Cross-table command collision: custom command trigger '${normalizedTriggerString}' also exists in counter trigger/check commands.`);
    }

    const baseCommand = toDbCustomCommand(command);

    if (command.is_discord_enabled) {
      if (discordByTrigger.has(normalizedTriggerString)) {
        console.warn(`[DB] Custom command Discord trigger collision: '${normalizedTriggerString}' is already registered (command_id=${discordByTrigger.get(normalizedTriggerString)!.command_id}); ignoring duplicate from command_id=${command.command_id}.`);
      } else {
        discordByTrigger.set(normalizedTriggerString, baseCommand);
      }
    }

    if (command.is_multi_twitch) {
      for (const activeChannel of normalizedActiveTwitchChannels) {
        const cacheKey = getTwitchCommandCacheKey(activeChannel, normalizedTriggerString);
        if (!cacheKey) continue;
        if (twitchByChannelAndTrigger.has(cacheKey)) {
          console.warn(`[DB] Custom command Twitch trigger collision: '${normalizedTriggerString}' in channel '${activeChannel}' is already registered (command_id=${twitchByChannelAndTrigger.get(cacheKey)!.command_id}); ignoring duplicate from command_id=${command.command_id}.`);
          continue;
        }
        twitchByChannelAndTrigger.set(cacheKey, baseCommand);
      }
    }

    for (const assignedUser of command.assigned_users) {
      if (!assignedUser.twitch_name || !assignedUser.is_twitch_bot_enabled) {
        continue;
      }

      const cacheKey = getTwitchCommandCacheKey(assignedUser.twitch_name, normalizedTriggerString);
      if (!cacheKey) continue;
      if (twitchByChannelAndTrigger.has(cacheKey)) {
        console.warn(`[DB] Custom command Twitch trigger collision: '${normalizedTriggerString}' in channel '${assignedUser.twitch_name}' is already registered (command_id=${twitchByChannelAndTrigger.get(cacheKey)!.command_id}); ignoring duplicate from command_id=${command.command_id}.`);
        continue;
      }
      twitchByChannelAndTrigger.set(cacheKey, baseCommand);
    }
  }

  return {
    loadedAt: Date.now(),
    discordByTrigger,
    twitchByChannelAndTrigger,
  };
}

const customCommandLookupCacheState = createManagedLookupCache<CustomCommandLookupCache>({
  cacheName: 'custom command cache',
  ttlMs: CUSTOM_COMMAND_CACHE_TTL_MS,
  refreshFailureBackoffMs: CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_BACKOFF_MS,
  refreshFailureMaxBackoffMs: CUSTOM_COMMAND_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS,
  createEmptyCache: createEmptyCustomCommandLookupCache,
  loadCache: async () => {
    const [commands, activeTwitchChannels, counters] = await Promise.all([
      getAllCustomCommandsWithAssignments(),
      getTwitchEnabledChannels(),
      getAllCounters(),
    ]);

    const counterCommands = new Set<string>();
    for (const counter of counters) {
      const normalizedTriggerCommand = counter.trigger_command.trim().toLowerCase();
      if (normalizedTriggerCommand) {
        counterCommands.add(normalizedTriggerCommand);
      }

      const normalizedCheckCommand = counter.check_command.trim().toLowerCase();
      if (normalizedCheckCommand) {
        counterCommands.add(normalizedCheckCommand);
      }
    }

    return buildCustomCommandLookupCache(commands, activeTwitchChannels, counterCommands);
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

function requireTrimmedString(value: string, fieldName: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`Missing ${fieldName}`);
  }
  return normalizedValue;
}

function normalizeCommand(command: string): string | null {
  const normalizedCommand = command.trim().toLowerCase();
  return normalizedCommand.length > 0 ? normalizedCommand : null;
}

function normalizeCommandList(commandOrCommands: string | string[]): string[] {
  const commands = Array.isArray(commandOrCommands) ? commandOrCommands : [commandOrCommands];

  return commands
    .map((command) => normalizeCommand(command))
    .filter((command): command is string => command !== null);
}

function normalizeCommandInputs(commandOrCommands: string | string[]): string[] {
  return Array.from(new Set(normalizeCommandList(commandOrCommands)));
}

function buildInClausePlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function getCommandWriteLockName(command: string): string {
  return `bcuk_cmd_${createHash('sha256').update(command).digest('hex').slice(0, 48)}`;
}

async function acquireNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  const [rows] = await connection.execute<mysql.RowDataPacket[]>(
    'SELECT GET_LOCK(?, ?) AS lock_status',
    [lockName, COMMAND_WRITE_LOCK_TIMEOUT_SECONDS],
  );

  if (rows[0]?.lock_status !== 1) {
    throw new Error(`Timed out acquiring command write lock: ${lockName}`);
  }
}

async function releaseNamedLock(connection: mysql.PoolConnection, lockName: string): Promise<void> {
  try {
    await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  } catch (error) {
    console.warn(`[DB] Failed to release command write lock '${lockName}':`, error);
  }
}

export class CommandConflictError extends Error {
  readonly commands: string[];

  constructor(commands: string[]) {
    super(`Command already taken: ${commands.join(', ')}`);
    this.name = 'CommandConflictError';
    this.commands = commands;
  }
}

export function isMysqlDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const mysqlError = error as { code?: string; errno?: number };
  return mysqlError.code === 'ER_DUP_ENTRY' || mysqlError.errno === 1062;
}

async function runSerializedCommandWrite<T>(
  commandOrCommands: string | string[],
  options: { excludeCustomCommandId?: number; excludeCounterId?: number } | undefined,
  writeOperation: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const normalizedCommands = normalizeCommandInputs(commandOrCommands);
  const lockNames = normalizedCommands
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((command) => getCommandWriteLockName(command));
  const connection = await getPool().getConnection();

  try {
    for (const lockName of lockNames) {
      await acquireNamedLock(connection, lockName);
    }

    await connection.beginTransaction();

    try {
      if (await isAnyCommandTakenAcrossTables(normalizedCommands, options, connection)) {
        throw new CommandConflictError(normalizedCommands);
      }

      const result = await writeOperation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    for (let index = lockNames.length - 1; index >= 0; index -= 1) {
      await releaseNamedLock(connection, lockNames[index]);
    }

    connection.release();
  }
}

async function isAnyCommandTakenAcrossTables(
  commandOrCommands: string | string[],
  options?: { excludeCustomCommandId?: number; excludeCounterId?: number },
  executor: SqlExecutor = getPool(),
): Promise<boolean> {
  const normalizedCommands = normalizeCommandInputs(commandOrCommands);
  if (normalizedCommands.length === 0) {
    return false;
  }

  const placeholders = buildInClausePlaceholders(normalizedCommands.length);

  let customCommandSql = `SELECT 1 FROM custom_command WHERE trigger_string IN (${placeholders})`;
  const customCommandParams: Array<string | number> = [...normalizedCommands];
  if (options?.excludeCustomCommandId !== undefined) {
    customCommandSql += ' AND command_id != ?';
    customCommandParams.push(options.excludeCustomCommandId);
  }
  customCommandSql += ' LIMIT 1';

  let counterSql = `SELECT 1 FROM counter WHERE (trigger_command IN (${placeholders}) OR check_command IN (${placeholders}))`;
  const counterParams: Array<string | number> = [...normalizedCommands, ...normalizedCommands];
  if (options?.excludeCounterId !== undefined) {
    counterSql += ' AND id != ?';
    counterParams.push(options.excludeCounterId);
  }
  counterSql += ' LIMIT 1';

  const [customRowsResult, counterRowsResult] = await Promise.all([
    executor.execute<mysql.RowDataPacket[]>(customCommandSql, customCommandParams),
    executor.execute<mysql.RowDataPacket[]>(counterSql, counterParams),
  ]);

  const [customRows] = customRowsResult;
  const [counterRows] = counterRowsResult;
  return customRows.length > 0 || counterRows.length > 0;
}

export async function isCustomCommandTriggerTaken(triggerString: string, excludeCommandId?: number): Promise<boolean> {
  return await isAnyCommandTakenAcrossTables(triggerString, { excludeCustomCommandId: excludeCommandId });
}

export async function addCustomCommand(
  triggerString: string,
  output: string,
  isDiscordEnabled: boolean,
  isMultiTwitch: boolean,
): Promise<void> {
  const normalizedTriggerString = requireTrimmedString(triggerString, 'trigger_string').toLowerCase();
  const normalizedOutput = requireTrimmedString(output, 'output');

  await runSerializedCommandWrite(normalizedTriggerString, undefined, async (connection) => {
    await connection.execute(
      `INSERT INTO custom_command (trigger_string, output, is_discord_enabled, is_multi_twitch)
       VALUES (?, ?, ?, ?)`,
      [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0],
    );
  });

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
      await connection.execute(
        `UPDATE custom_command
         SET trigger_string = ?, output = ?, is_discord_enabled = ?, is_multi_twitch = ?
         WHERE command_id = ?`,
        [normalizedTriggerString, normalizedOutput, isDiscordEnabled ? 1 : 0, isMultiTwitch ? 1 : 0, commandId],
      );
    },
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
    invalidateCustomCommandLookupCache();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function assignUserToCommand(commandId: number, discordId: string): Promise<void> {
  await getPool().execute(
    `INSERT INTO twitch_user_commands (command_id, discord_id)
     VALUES (?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       command_id = command_id`,
    [commandId, discordId],
  );

  invalidateCustomCommandLookupCache();
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
    reset_yearly: Buffer.isBuffer(row.reset_yearly) ? row.reset_yearly[0] === 1 : row.reset_yearly == 1,
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

const COUNTER_LOOKUP_CACHE_TTL_MS = 15_000;
const COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_BACKOFF_MS = 5_000;
const COUNTER_LOOKUP_CACHE_REFRESH_FAILURE_MAX_BACKOFF_MS = 60_000;

function buildCounterLookupCache(counters: DbCounter[], customCommandTriggers: Set<string>): CounterLookupCache {
  const byCommand = new Map<string, DbMatchedCounter>();
  const loggedCrossTableCollisions = new Set<string>();
  const sortedCounters = [...counters].sort((left, right) => left.id - right.id);

  for (const counter of sortedCounters) {
    const normalizedTriggerCommand = counter.trigger_command.trim().toLowerCase();
    if (normalizedTriggerCommand) {
      if (customCommandTriggers.has(normalizedTriggerCommand) && !loggedCrossTableCollisions.has(normalizedTriggerCommand)) {
        loggedCrossTableCollisions.add(normalizedTriggerCommand);
        console.warn(`[DB] Cross-table command collision: counter trigger/check command '${normalizedTriggerCommand}' also exists in custom command triggers.`);
      }
      if (byCommand.has(normalizedTriggerCommand)) {
        console.warn(`[DB] Counter trigger_command collision: '${normalizedTriggerCommand}' is already registered (counter id=${byCommand.get(normalizedTriggerCommand)!.id}); ignoring duplicate from counter id=${counter.id}.`);
      } else {
        byCommand.set(normalizedTriggerCommand, { ...counter, matchType: 'trigger' });
      }
    }

    const normalizedCheckCommand = counter.check_command.trim().toLowerCase();
    if (normalizedCheckCommand) {
      if (customCommandTriggers.has(normalizedCheckCommand) && !loggedCrossTableCollisions.has(normalizedCheckCommand)) {
        loggedCrossTableCollisions.add(normalizedCheckCommand);
        console.warn(`[DB] Cross-table command collision: counter trigger/check command '${normalizedCheckCommand}' also exists in custom command triggers.`);
      }
      if (byCommand.has(normalizedCheckCommand)) {
        console.warn(`[DB] Counter check_command collision: '${normalizedCheckCommand}' is already registered (counter id=${byCommand.get(normalizedCheckCommand)!.id}); ignoring duplicate from counter id=${counter.id}.`);
      } else {
        byCommand.set(normalizedCheckCommand, { ...counter, matchType: 'check' });
      }
    }
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
    const [counters, customCommands] = await Promise.all([
      getAllCounters(),
      getAllCustomCommandsWithAssignments(),
    ]);

    const customCommandTriggers = new Set<string>();
    for (const customCommand of customCommands) {
      const normalizedTrigger = customCommand.trigger_string.trim().toLowerCase();
      if (normalizedTrigger) {
        customCommandTriggers.add(normalizedTrigger);
      }
    }

    return buildCounterLookupCache(counters, customCommandTriggers);
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

export async function updateCounter(
  id: number,
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

// ─── Stream monitor ──────────────────────────────────────────────────────────

export interface DbStreamGroup {
  id: number;
  name: string;
  discord_channel: string;
  live_message: string;
  new_game_message: string;
  multi_twitch: boolean;
  multi_twitch_message: string;
  delete_old_posts: boolean;
}

/** Flat view used by the admin web panel (streamer + group name only). */
export interface DbStreamer {
  id: number;
  name: string;
  group_id: number;
  group_name: string;
}

/** Full view used by twitchMonitor — includes DB-persisted live state. */
export interface DbStreamerFull {
  id: number;
  name: string;
  discord_message_id: string | null;
  discord_channel_id: string | null;
  live_game: string | null;
  group: DbStreamGroup;
}

function mapStreamGroup(r: mysql.RowDataPacket): DbStreamGroup {
  return {
    id: r.id,
    name: r.name,
    discord_channel: String(r.discord_channel),
    live_message: r.live_message,
    new_game_message: r.new_game_message,
    multi_twitch: Buffer.isBuffer(r.multi_twitch) ? r.multi_twitch[0] === 1 : r.multi_twitch == 1,
    multi_twitch_message: r.multi_twitch_message ?? '',
    delete_old_posts: Buffer.isBuffer(r.delete_old_posts) ? r.delete_old_posts[0] === 1 : r.delete_old_posts == 1,
  };
}

export async function getAllStreamGroups(): Promise<DbStreamGroup[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name, discord_channel, live_message, new_game_message, multi_twitch, multi_twitch_message, delete_old_posts
     FROM stream_group ORDER BY name`,
  );
  return rows.map(mapStreamGroup);
}

export async function addStreamGroup(
  name: string,
  discordChannel: string,
  liveMessage: string,
  newGameMessage: string,
  multiTwitch: boolean,
  multiTwitchMessage: string,
  deleteOldPosts: boolean,
): Promise<void> {
  await getPool().execute(
    `INSERT INTO stream_group (name, discord_channel, live_message, new_game_message, multi_twitch, multi_twitch_message, delete_old_posts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, discordChannel, liveMessage, newGameMessage, multiTwitch ? 1 : 0, multiTwitchMessage, deleteOldPosts ? 1 : 0],
  );
}

export async function updateStreamGroup(
  id: number,
  name: string,
  discordChannel: string,
  liveMessage: string,
  newGameMessage: string,
  multiTwitch: boolean,
  multiTwitchMessage: string,
  deleteOldPosts: boolean,
): Promise<void> {
  await getPool().execute(
    `UPDATE stream_group SET name=?, discord_channel=?, live_message=?, new_game_message=?, multi_twitch=?, multi_twitch_message=?, delete_old_posts=?
     WHERE id=?`,
    [name, discordChannel, liveMessage, newGameMessage, multiTwitch ? 1 : 0, multiTwitchMessage, deleteOldPosts ? 1 : 0, id],
  );
}

export async function removeStreamGroup(id: number): Promise<void> {
  await getPool().execute('DELETE FROM stream_group WHERE id = ?', [id]);
}

export async function getAllStreamers(): Promise<DbStreamer[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.name, s.group_id, g.name AS group_name
     FROM streamer s
     JOIN stream_group g ON s.group_id = g.id
     ORDER BY g.name, s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    group_id: r.group_id,
    group_name: r.group_name,
  }));
}

export async function getAllStreamersWithGroups(): Promise<DbStreamerFull[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.name, s.group_id,
            s.discord_message_id, s.discord_channel_id, s.live_game,
            g.name AS group_name, g.discord_channel, g.live_message, g.new_game_message,
            g.multi_twitch, g.multi_twitch_message, g.delete_old_posts
     FROM streamer s
     JOIN stream_group g ON s.group_id = g.id
     ORDER BY g.id, s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    discord_message_id: r.discord_message_id ?? null,
    discord_channel_id: r.discord_channel_id !== null && r.discord_channel_id !== undefined ? String(r.discord_channel_id) : null,
    live_game: r.live_game ?? null,
    group: {
      id: r.group_id,
      name: r.group_name,
      discord_channel: String(r.discord_channel),
      live_message: r.live_message,
      new_game_message: r.new_game_message,
      multi_twitch: Buffer.isBuffer(r.multi_twitch) ? r.multi_twitch[0] === 1 : r.multi_twitch == 1,
      multi_twitch_message: r.multi_twitch_message ?? '',
      delete_old_posts: Buffer.isBuffer(r.delete_old_posts) ? r.delete_old_posts[0] === 1 : r.delete_old_posts == 1,
    },
  }));
}

export async function addStreamer(name: string, groupId: number): Promise<void> {
  await getPool().execute(
    'INSERT INTO streamer (name, group_id) VALUES (?, ?)',
    [name.toLowerCase().trim(), groupId],
  );
}

export async function removeStreamer(id: number): Promise<void> {
  await getPool().execute('DELETE FROM streamer WHERE id = ?', [id]);
}

export async function removeStreamersByGroup(groupId: number): Promise<void> {
  await getPool().execute('DELETE FROM streamer WHERE group_id = ?', [groupId]);
}

export async function setStreamerLive(
  id: number,
  messageId: string,
  channelId: string,
  game: string,
): Promise<void> {
  await getPool().execute(
    'UPDATE streamer SET discord_message_id=?, discord_channel_id=?, live_game=? WHERE id=?',
    [messageId, channelId, game, id],
  );
}

export async function clearStreamerLive(id: number): Promise<void> {
  await getPool().execute(
    'UPDATE streamer SET discord_message_id=NULL, discord_channel_id=NULL, live_game=NULL WHERE id=?',
    [id],
  );
}

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
        hidden: Buffer.isBuffer(r.triggerHidden) ? r.triggerHidden[0] === 1 : r.triggerHidden == 1,
        categoryName: r.categoryName ?? null,
        files: [],
      });
    }
    if (r.sfxId !== null) {
      map.get(r.triggerId)!.files.push({
        id: r.sfxId,
        file: r.file,
        weight: r.weight,
        hidden: Buffer.isBuffer(r.sfxHidden) ? r.sfxHidden[0] === 1 : r.sfxHidden == 1,
      });
    }
  }
  return Array.from(map.values());
}
