import mysql from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from './config';

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
    hidden: Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden === 1,
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
    hidden: Buffer.isBuffer(row.hidden) ? row.hidden[0] === 1 : row.hidden === 1,
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
    is_twitch_bot_enabled: Buffer.isBuffer(r.is_twitch_bot_enabled) ? r.is_twitch_bot_enabled[0] === 1 : r.is_twitch_bot_enabled === 1,
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
    is_twitch_bot_enabled: Buffer.isBuffer(r.is_twitch_bot_enabled) ? r.is_twitch_bot_enabled[0] === 1 : r.is_twitch_bot_enabled === 1,
    twitch_name: r.twitch_name,
    access_level: r.access_level,
  }));
}

export async function upsertUser(
  discordId: string,
  discordName: string,
  accessLevel: number,
  twitchName?: string,
): Promise<void> {
  if (!(Object.values(AccessLevel) as number[]).includes(accessLevel)) {
    throw new Error(`Invalid accessLevel: ${accessLevel}`);
  }
  const normalizedTwitchName = twitchName !== undefined
    ? (twitchName.trim() || null)
    : null;
  await getPool().execute(
    `INSERT INTO \`user\` (discord_id, discord_name, access_level, twitch_name, is_twitch_bot_enabled)
     VALUES (?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE discord_name = VALUES(discord_name), access_level = VALUES(access_level), twitch_name = VALUES(twitch_name)`,
    [discordId, discordName, accessLevel, normalizedTwitchName],
  );
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
    .map((r) => String(r.twitch_name).trim().toLowerCase())
    .filter((v) => v.length > 0);
}

export async function updateTwitchBotEnabled(discordId: string, enabled: boolean): Promise<void> {
  await getPool().execute(
    'UPDATE `user` SET is_twitch_bot_enabled = ? WHERE discord_id = ?',
    [enabled ? 1 : 0, discordId],
  );
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
    multi_twitch: Buffer.isBuffer(r.multi_twitch) ? r.multi_twitch[0] === 1 : r.multi_twitch === 1,
    multi_twitch_message: r.multi_twitch_message ?? '',
    delete_old_posts: Buffer.isBuffer(r.delete_old_posts) ? r.delete_old_posts[0] === 1 : r.delete_old_posts === 1,
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
      multi_twitch: Buffer.isBuffer(r.multi_twitch) ? r.multi_twitch[0] === 1 : r.multi_twitch === 1,
      multi_twitch_message: r.multi_twitch_message ?? '',
      delete_old_posts: Buffer.isBuffer(r.delete_old_posts) ? r.delete_old_posts[0] === 1 : r.delete_old_posts === 1,
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
        hidden: Buffer.isBuffer(r.triggerHidden) ? r.triggerHidden[0] === 1 : r.triggerHidden === 1,
        categoryName: r.categoryName ?? null,
        files: [],
      });
    }
    if (r.sfxId !== null) {
      map.get(r.triggerId)!.files.push({
        id: r.sfxId,
        file: r.file,
        weight: r.weight,
        hidden: Buffer.isBuffer(r.sfxHidden) ? r.sfxHidden[0] === 1 : r.sfxHidden === 1,
      });
    }
  }
  return Array.from(map.values());
}
