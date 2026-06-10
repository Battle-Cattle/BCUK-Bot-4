import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';

export interface DbStreamGroup {
  id: number;
  name: string;
  discord_channel: string;
  live_message: string;
  new_game_message: string;
  multi_twitch: boolean;
  delete_old_posts: boolean;
}

export interface AddStreamGroupInput {
  name: string;
  discordChannel: string;
  liveMessage: string;
  newGameMessage: string;
  multiTwitch: boolean;
  deleteOldPosts: boolean;
}

export interface UpdateStreamGroupInput extends AddStreamGroupInput {
  id: number;
}

/** Flat view used by the admin web panel (streamer + group name only). */
export interface DbStreamer {
  id: number;
  discord_id: string;
  twitch_name: string | null;
  discord_name: string | null;
  group_id: number;
  group_name: string;
}

/** Full view used by twitchMonitor — includes DB-persisted live state. */
export interface DbStreamerFull {
  id: number;
  discord_id: string;
  twitch_name: string | null;
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
    multi_twitch: fromBit(r.multi_twitch),
    delete_old_posts: fromBit(r.delete_old_posts),
  };
}

function streamGroupParams(input: AddStreamGroupInput): Array<string | number> {
  return [
    input.name,
    input.discordChannel,
    input.liveMessage,
    input.newGameMessage,
    input.multiTwitch ? 1 : 0,
    input.deleteOldPosts ? 1 : 0,
  ];
}

/** Return all stream groups ordered by name. */
export async function getAllStreamGroups(): Promise<DbStreamGroup[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name, discord_channel, live_message, new_game_message, multi_twitch, delete_old_posts
     FROM stream_group ORDER BY name`,
  );
  return rows.map(mapStreamGroup);
}

/**
 * Insert a new stream group.
 *
 * @param input - Stream group fields to store.
 */
export async function addStreamGroup(input: AddStreamGroupInput): Promise<void> {
  await getPool().execute(
    `INSERT INTO stream_group (name, discord_channel, live_message, new_game_message, multi_twitch, delete_old_posts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    streamGroupParams(input),
  );
}

/**
 * Update all fields of an existing stream group.
 *
 * @param input - Updated stream group fields; `id` identifies the row to update.
 */
export async function updateStreamGroup(input: UpdateStreamGroupInput): Promise<void> {
  await getPool().execute(
    `UPDATE stream_group SET name=?, discord_channel=?, live_message=?, new_game_message=?, multi_twitch=?, delete_old_posts=?
     WHERE id=?`,
    [...streamGroupParams(input), input.id],
  );
}

/**
 * Delete a stream group by ID.
 *
 * @param id - Primary key of the stream group to remove.
 */
export async function removeStreamGroup(id: number): Promise<void> {
  await getPool().execute('DELETE FROM stream_group WHERE id = ?', [id]);
}

/** Return all streamers with their group name, ordered by group then Twitch name (flat view for the admin panel). */
export async function getAllStreamers(): Promise<DbStreamer[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.discord_id, s.group_id,
            u.twitch_name, u.discord_name,
            g.name AS group_name
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     JOIN stream_group g ON s.group_id = g.id
     ORDER BY g.name, u.twitch_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    discord_id: String(r.discord_id),
    twitch_name: r.twitch_name ?? null,
    discord_name: r.discord_name ?? null,
    group_id: r.group_id,
    group_name: r.group_name,
  }));
}

/** Return all streamers with their full group configuration, ordered by group then Twitch name (used by twitchMonitor). */
export async function getAllStreamersWithGroups(): Promise<DbStreamerFull[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.discord_id, s.group_id,
            u.twitch_name,
            s.discord_message_id, s.discord_channel_id, s.live_game,
            g.name AS group_name, g.discord_channel, g.live_message, g.new_game_message,
            g.multi_twitch, g.delete_old_posts
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     JOIN stream_group g ON s.group_id = g.id
     ORDER BY g.id, u.twitch_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    discord_id: String(r.discord_id),
    twitch_name: r.twitch_name ?? null,
    discord_message_id: r.discord_message_id ?? null,
    discord_channel_id: r.discord_channel_id !== null && r.discord_channel_id !== undefined ? String(r.discord_channel_id) : null,
    live_game: r.live_game ?? null,
    group: {
      id: r.group_id,
      name: r.group_name,
      discord_channel: String(r.discord_channel),
      live_message: r.live_message,
      new_game_message: r.new_game_message,
      multi_twitch: fromBit(r.multi_twitch),
      delete_old_posts: fromBit(r.delete_old_posts),
    },
  }));
}

/**
 * Add a streamer to a stream group.
 *
 * @param discordId - Discord snowflake of the user to register as a streamer.
 * @param groupId - ID of the stream group to add the streamer to.
 */
export async function addStreamer(discordId: string, groupId: number): Promise<void> {
  await getPool().execute(
    'INSERT INTO streamer (discord_id, group_id) VALUES (?, ?)',
    [discordId, groupId],
  );
}

/**
 * Remove a streamer row by its DB ID.
 *
 * @param id - Primary key of the streamer row to delete.
 */
export async function removeStreamer(id: number): Promise<void> {
  await getPool().execute('DELETE FROM streamer WHERE id = ?', [id]);
}

/**
 * Remove all streamers belonging to a given stream group.
 *
 * @param groupId - ID of the stream group whose streamers should be deleted.
 */
export async function removeStreamersByGroup(groupId: number): Promise<void> {
  await getPool().execute('DELETE FROM streamer WHERE group_id = ?', [groupId]);
}

/**
 * Persist the Discord message details for a streamer's current live post.
 *
 * @param id - DB row ID of the streamer.
 * @param messageId - Discord message snowflake of the live announcement post.
 * @param channelId - Discord channel snowflake where the post was sent.
 * @param game - Game title reported at the time of going live.
 */
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

/**
 * Clear a streamer's live post state, nulling the stored message, channel, and game.
 *
 * @param id - DB row ID of the streamer to mark as offline.
 */
export async function clearStreamerLive(id: number): Promise<void> {
  await getPool().execute(
    'UPDATE streamer SET discord_message_id=NULL, discord_channel_id=NULL, live_game=NULL WHERE id=?',
    [id],
  );
}
