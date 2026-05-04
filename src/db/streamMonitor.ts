import mysql from 'mysql2/promise';
import { getPool } from './pool';

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

export interface AddStreamGroupInput {
  name: string;
  discordChannel: string;
  liveMessage: string;
  newGameMessage: string;
  multiTwitch: boolean;
  multiTwitchMessage: string;
  deleteOldPosts: boolean;
}

export interface UpdateStreamGroupInput extends AddStreamGroupInput {
  id: number;
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

function mapBool(value: unknown): boolean {
  return Buffer.isBuffer(value) ? value[0] === 1 : value == 1;
}

function mapStreamGroup(r: mysql.RowDataPacket): DbStreamGroup {
  return {
    id: r.id,
    name: r.name,
    discord_channel: String(r.discord_channel),
    live_message: r.live_message,
    new_game_message: r.new_game_message,
    multi_twitch: mapBool(r.multi_twitch),
    multi_twitch_message: r.multi_twitch_message ?? '',
    delete_old_posts: mapBool(r.delete_old_posts),
  };
}

function streamGroupParams(input: AddStreamGroupInput): Array<string | number> {
  return [
    input.name,
    input.discordChannel,
    input.liveMessage,
    input.newGameMessage,
    input.multiTwitch ? 1 : 0,
    input.multiTwitchMessage,
    input.deleteOldPosts ? 1 : 0,
  ];
}

export async function getAllStreamGroups(): Promise<DbStreamGroup[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name, discord_channel, live_message, new_game_message, multi_twitch, multi_twitch_message, delete_old_posts
     FROM stream_group ORDER BY name`,
  );
  return rows.map(mapStreamGroup);
}

export async function addStreamGroup(input: AddStreamGroupInput): Promise<void> {
  await getPool().execute(
    `INSERT INTO stream_group (name, discord_channel, live_message, new_game_message, multi_twitch, multi_twitch_message, delete_old_posts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    streamGroupParams(input),
  );
}

export async function updateStreamGroup(input: UpdateStreamGroupInput): Promise<void> {
  await getPool().execute(
    `UPDATE stream_group SET name=?, discord_channel=?, live_message=?, new_game_message=?, multi_twitch=?, multi_twitch_message=?, delete_old_posts=?
     WHERE id=?`,
    [...streamGroupParams(input), input.id],
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
      multi_twitch: mapBool(r.multi_twitch),
      multi_twitch_message: r.multi_twitch_message ?? '',
      delete_old_posts: mapBool(r.delete_old_posts),
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
