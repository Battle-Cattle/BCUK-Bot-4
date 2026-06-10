import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';
import { EVENTSUB_TOKEN_SECRET } from '../shared/config';
import { encryptToken, decryptToken } from '../shared/crypto';

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
  eventsub_token_expiry: string | null;
  config: EventSubConfig | null;
}

function mapConfig(r: mysql.RowDataPacket): EventSubConfig {
  return {
    follow_enabled: fromBit(r.follow_enabled),
    follow_message: r.follow_message,
    sub_enabled: fromBit(r.sub_enabled),
    sub_message: r.sub_message,
    resub_message: r.resub_message,
    giftsub_message: r.giftsub_message,
    raid_enabled: fromBit(r.raid_enabled),
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
    eventsub_token_expiry: r.eventsub_token_expiry != null ? String(r.eventsub_token_expiry) : null,
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

/** Return all Twitch-bot-enabled streamers with their EventSub OAuth tokens and event config. */
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

/**
 * Look up a streamer by their Discord snowflake ID. Returns null if not found.
 *
 * @param discordId - Discord user snowflake to search for.
 */
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

/**
 * Look up a streamer by their DB row ID. Returns null if not found.
 *
 * @param id - Primary key of the `streamer` row.
 */
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

/**
 * Encrypt and persist a streamer's EventSub OAuth tokens. Throws if
 * `EVENTSUB_TOKEN_SECRET` is not configured, to prevent storing plaintext credentials.
 *
 * @param streamerId - DB row ID of the streamer to update.
 * @param twitchUserId - Twitch user ID associated with the tokens.
 * @param accessToken - OAuth access token (encrypted before storage).
 * @param refreshToken - OAuth refresh token (encrypted before storage).
 * @param expiryMs - Token expiry as Unix epoch milliseconds, or null if unknown.
 */
export async function saveStreamerToken(
  streamerId: number,
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number | null,
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

/**
 * Null out all OAuth token fields for a streamer (used on logout or token revocation).
 *
 * @param streamerId - DB row ID of the streamer whose tokens should be cleared.
 */
export async function clearStreamerToken(streamerId: number): Promise<void> {
  await getPool().execute(
    `UPDATE streamer
     SET twitch_user_id=NULL, eventsub_access_token=NULL, eventsub_refresh_token=NULL, eventsub_token_expiry=NULL
     WHERE id=?`,
    [streamerId],
  );
}

const DEFAULT_EVENT_CONFIG: EventSubConfig = {
  follow_enabled: false,
  follow_message: 'Thanks {display_name} for the follow!',
  sub_enabled: false,
  sub_message: 'Thanks {display_name} for subscribing! (Tier {tier})',
  resub_message: 'Thanks {display_name} for {months} months! (Tier {tier})',
  giftsub_message: '{gifter_display} gifted {count} sub(s) to the community!',
  raid_enabled: false,
  raid_message: 'Welcome raiders from {from_display}! Thank you for the {viewers} person raid!',
};

/**
 * Insert a default event config row for a streamer if one does not already exist.
 * Uses INSERT IGNORE so it is safe to call multiple times without overwriting existing config.
 *
 * @param streamerId - DB row ID of the streamer to initialise config for.
 */
export async function initEventConfig(streamerId: number): Promise<void> {
  const c = DEFAULT_EVENT_CONFIG;
  await getPool().execute(
    `INSERT IGNORE INTO streamer_event_config
       (streamer_id, follow_enabled, follow_message,
        sub_enabled, sub_message, resub_message, giftsub_message,
        raid_enabled, raid_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      streamerId,
      c.follow_enabled ? 1 : 0, c.follow_message,
      c.sub_enabled ? 1 : 0, c.sub_message, c.resub_message, c.giftsub_message,
      c.raid_enabled ? 1 : 0, c.raid_message,
    ],
  );
}

/**
 * Upsert the event config for a streamer. Inserts a new row or updates all fields
 * if a row for this streamer already exists.
 *
 * @param streamerId - DB row ID of the streamer.
 * @param config - Full event config to persist; boolean flags are stored as BIT(1).
 */
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
