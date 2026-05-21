import mysql from 'mysql2/promise';
import { getPool } from './pool';

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
  name: string;
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

export async function getAllEventSubStreamers(): Promise<DbStreamerEventSub[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.name, s.twitch_user_id,
            s.eventsub_access_token, s.eventsub_refresh_token, s.eventsub_token_expiry,
            c.follow_enabled, c.follow_message,
            c.sub_enabled, c.sub_message, c.resub_message, c.giftsub_message,
            c.raid_enabled, c.raid_message
     FROM streamer s
     LEFT JOIN streamer_event_config c ON c.streamer_id = s.id
     ORDER BY s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    twitch_user_id: r.twitch_user_id ?? null,
    eventsub_access_token: r.eventsub_access_token ?? null,
    eventsub_refresh_token: r.eventsub_refresh_token ?? null,
    eventsub_token_expiry: r.eventsub_token_expiry != null ? Number(r.eventsub_token_expiry) : null,
    config: r.follow_enabled != null ? mapConfig(r) : null,
  }));
}

export async function saveStreamerToken(
  streamerId: number,
  twitchUserId: string,
  accessToken: string,
  refreshToken: string,
  expiryMs: number,
): Promise<void> {
  await getPool().execute(
    `UPDATE streamer
     SET twitch_user_id=?, eventsub_access_token=?, eventsub_refresh_token=?, eventsub_token_expiry=?
     WHERE id=?`,
    [twitchUserId, accessToken, refreshToken, expiryMs, streamerId],
  );
}

export async function clearStreamerToken(streamerId: number): Promise<void> {
  await getPool().execute(
    `UPDATE streamer
     SET eventsub_access_token=NULL, eventsub_refresh_token=NULL, eventsub_token_expiry=NULL
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       follow_enabled=VALUES(follow_enabled), follow_message=VALUES(follow_message),
       sub_enabled=VALUES(sub_enabled), sub_message=VALUES(sub_message),
       resub_message=VALUES(resub_message), giftsub_message=VALUES(giftsub_message),
       raid_enabled=VALUES(raid_enabled), raid_message=VALUES(raid_message)`,
    [
      streamerId,
      config.follow_enabled ? 1 : 0, config.follow_message,
      config.sub_enabled ? 1 : 0, config.sub_message, config.resub_message, config.giftsub_message,
      config.raid_enabled ? 1 : 0, config.raid_message,
    ],
  );
}
