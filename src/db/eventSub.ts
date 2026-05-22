import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { EVENTSUB_TOKEN_SECRET } from '../config';
import { encryptToken, decryptToken } from '../crypto';

export interface EventSubConfig {
  follow_enabled: boolean;
  follow_message: string;
  sub_enabled: boolean;
  sub_message: string;
  resub_message: string;
  giftsub_message: string;
  raid_enabled: boolean;
  raid_message: string;
}

export interface DbStreamerEventSub {
  id: number;
  discord_id: string;
  twitch_name: string | null;
  twitch_user_id: string | null;
  eventsub_access_token: string | null;
  eventsub_refresh_token: string | null;
  eventsub_token_expiry: number | null;
  config: EventSubConfig | null;
}

function mapBool(value: unknown): boolean {
  return Buffer.isBuffer(value) ? value[0] === 1 : value == 1;
}

function mapConfig(r: mysql.RowDataPacket): EventSubConfig {
  return {
    follow_enabled: mapBool(r.follow_enabled),
    follow_message: r.follow_message,
    sub_enabled: mapBool(r.sub_enabled),
    sub_message: r.sub_message,
    resub_message: r.resub_message,
    giftsub_message: r.giftsub_message,
    raid_enabled: mapBool(r.raid_enabled),
    raid_message: r.raid_message,
  };
}

function maybeDecrypt(value: string | null): string | null {
  if (!value) return null;
  if (!EVENTSUB_TOKEN_SECRET) return null; // secret absent — treat stored value as unusable
  try {
    return decryptToken(value, EVENTSUB_TOKEN_SECRET);
  } catch {
    return null; // corrupted or wrong key — treat as missing
  }
}

function mapStreamerEventSub(r: mysql.RowDataPacket): DbStreamerEventSub {
  return {
    id: r.id,
    discord_id: String(r.discord_id),
    twitch_name: r.twitch_name ?? null,
    twitch_user_id: r.twitch_user_id ?? null,
    eventsub_access_token: maybeDecrypt(r.eventsub_access_token ?? null),
    eventsub_refresh_token: maybeDecrypt(r.eventsub_refresh_token ?? null),
    eventsub_token_expiry: r.eventsub_token_expiry != null ? Number(r.eventsub_token_expiry) : null,
    config: r.follow_enabled != null ? mapConfig(r) : null,
  };
}

const EVENT_SUB_SELECT = `
  s.id, s.discord_id, u.twitch_name,
  s.twitch_user_id,
  s.eventsub_access_token, s.eventsub_refresh_token, s.eventsub_token_expiry,
  c.follow_enabled, c.follow_message,
  c.sub_enabled, c.sub_message, c.resub_message, c.giftsub_message,
  c.raid_enabled, c.raid_message`;

export async function getAllEventSubStreamers(): Promise<DbStreamerEventSub[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${EVENT_SUB_SELECT}
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     LEFT JOIN streamer_event_config c ON c.streamer_id = s.id
     WHERE u.is_twitch_bot_enabled = 1
     ORDER BY u.twitch_name`,
  );
  return rows.map(mapStreamerEventSub);
}

export async function getStreamerByDiscordId(discordId: string): Promise<DbStreamerEventSub | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${EVENT_SUB_SELECT}
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     LEFT JOIN streamer_event_config c ON c.streamer_id = s.id
     WHERE s.discord_id = ?`,
    [discordId],
  );
  return rows.length === 0 ? null : mapStreamerEventSub(rows[0]);
}

export async function getStreamerById(id: number): Promise<DbStreamerEventSub | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT ${EVENT_SUB_SELECT}
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     LEFT JOIN streamer_event_config c ON c.streamer_id = s.id
     WHERE s.id = ?`,
    [id],
  );
  return rows.length === 0 ? null : mapStreamerEventSub(rows[0]);
}

export async function saveStreamerToken(
  streamerId: number,
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number,
): Promise<void> {
  if (!EVENTSUB_TOKEN_SECRET) throw new Error('EVENTSUB_TOKEN_SECRET is not configured — refusing to persist plaintext OAuth tokens');
  const storedAccess = encryptToken(accessToken, EVENTSUB_TOKEN_SECRET);
  const storedRefresh = encryptToken(refreshToken, EVENTSUB_TOKEN_SECRET);
  await getPool().execute(
    `UPDATE streamer
     SET twitch_user_id=?, eventsub_access_token=?, eventsub_refresh_token=?, eventsub_token_expiry=?
     WHERE id=?`,
    [twitchUserId, storedAccess, storedRefresh, expiryMs, streamerId],
  );
}

export async function clearStreamerToken(streamerId: number): Promise<void> {
  await getPool().execute(
    `UPDATE streamer
     SET twitch_user_id=NULL, eventsub_access_token=NULL, eventsub_refresh_token=NULL, eventsub_token_expiry=NULL
     WHERE id=?`,
    [streamerId],
  );
}

export async function saveEventConfig(streamerId: number, config: EventSubConfig): Promise<void> {
  await getPool().execute(
    `INSERT INTO streamer_event_config
       (streamer_id, follow_enabled, follow_message,
        sub_enabled, sub_message, resub_message, giftsub_message,
        raid_enabled, raid_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row
     ON DUPLICATE KEY UPDATE
       follow_enabled=new_row.follow_enabled, follow_message=new_row.follow_message,
       sub_enabled=new_row.sub_enabled, sub_message=new_row.sub_message,
       resub_message=new_row.resub_message, giftsub_message=new_row.giftsub_message,
       raid_enabled=new_row.raid_enabled, raid_message=new_row.raid_message`,
    [
      streamerId,
      config.follow_enabled ? 1 : 0, config.follow_message,
      config.sub_enabled ? 1 : 0, config.sub_message, config.resub_message, config.giftsub_message,
      config.raid_enabled ? 1 : 0, config.raid_message,
    ],
  );
}
