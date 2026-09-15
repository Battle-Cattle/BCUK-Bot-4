import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';
import { fromBit } from './utils';

export interface DbStreamGroup {
  id: number;
  guild_id: string;
  name: string;
  discord_channel: string;
  live_message: string;
  new_game_message: string;
  multi_twitch: boolean;
  delete_old_posts: boolean;
}

export interface AddStreamGroupInput {
  guildId: string;
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

/** Raw group-related field values, keyed the way `mapStreamGroup`/`buildStreamGroup` expect them, regardless of the source row's own column aliases. */
interface RawStreamGroupFields {
  id: number;
  guild_id: unknown;
  name: string;
  discord_channel: unknown;
  live_message: string;
  new_game_message: string;
  multi_twitch: unknown;
  delete_old_posts: unknown;
}

/** Converts raw group field values to a `DbStreamGroup`, converting BIGINT/bit columns to string/boolean. */
function buildStreamGroup(fields: RawStreamGroupFields): DbStreamGroup {
  return {
    id: fields.id,
    guild_id: String(fields.guild_id),
    name: fields.name,
    discord_channel: String(fields.discord_channel),
    live_message: fields.live_message,
    new_game_message: fields.new_game_message,
    multi_twitch: fromBit(fields.multi_twitch),
    delete_old_posts: fromBit(fields.delete_old_posts),
  };
}

/** Maps a `stream_group` row to a `DbStreamGroup`, converting BIGINT/bit columns to string/boolean. */
function mapStreamGroup(r: mysql.RowDataPacket): DbStreamGroup {
  return buildStreamGroup({
    id: r.id,
    guild_id: r.guild_id,
    name: r.name,
    discord_channel: r.discord_channel,
    live_message: r.live_message,
    new_game_message: r.new_game_message,
    multi_twitch: r.multi_twitch,
    delete_old_posts: r.delete_old_posts,
  });
}

/** Extracts the shared column values (everything but `guildId`/`id`) from an add/update input, in SQL parameter order. */
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

/**
 * Return one guild's stream groups ordered by name.
 * @param guildId - Guild whose stream groups to fetch.
 * @returns The guild's stream groups.
 */
export async function getStreamGroupsForGuild(guildId: string): Promise<DbStreamGroup[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, guild_id, name, discord_channel, live_message, new_game_message, multi_twitch, delete_old_posts
     FROM stream_group WHERE guild_id = ? ORDER BY name`,
    [guildId],
  );
  return rows.map(mapStreamGroup);
}

/**
 * Insert a new stream group, unless one with the same name already exists for this guild.
 * `stream_group` has no unique constraint on `(guild_id, name)` (the DB is managed outside this
 * repo — see CLAUDE.md), so this guards in the application layer instead with an `INSERT ...
 * SELECT ... WHERE NOT EXISTS`.
 *
 * This closes the race under InnoDB's default `REPEATABLE READ` isolation (nothing in
 * `pool.ts` overrides it, so the connection runs under whatever the server's own default is):
 * MySQL documents that an `INSERT ... SELECT` under `REPEATABLE READ` takes shared next-key
 * locks on the rows the `SELECT` scans, so two concurrent attempts for the same `guild_id`+`name`
 * serialize against each other and only one can affect a row. It does **not** close the race
 * under `READ COMMITTED` (or lower) — there, the same `SELECT` is a non-locking consistent read,
 * so two concurrent statements could both see "no existing row" and both insert. `ER_DUP_ENTRY`
 * is still caught below as forward-compatible defense-in-depth (harmless no-op today, since no
 * such constraint exists yet), but the only way to fully close this under any isolation level is
 * a real unique constraint on `(guild_id, name)` — a schema change outside this repo's control.
 *
 * @param input - Stream group fields to store, including the owning guild.
 * @returns True if the group was created; false if a group with that name already existed for
 *   this guild (nothing was inserted).
 */
export async function addStreamGroup(input: AddStreamGroupInput): Promise<boolean> {
  try {
    const [result] = await getPool().execute<mysql.ResultSetHeader>(
      `INSERT INTO stream_group (guild_id, name, discord_channel, live_message, new_game_message, multi_twitch, delete_old_posts)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM stream_group WHERE guild_id = ? AND name = ?)`,
      [input.guildId, ...streamGroupParams(input), input.guildId, input.name],
    );
    return result.affectedRows > 0;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

/**
 * Update all fields of an existing stream group. A no-op if `id` doesn't
 * belong to `guildId`, preventing one guild from editing another's group.
 *
 * @param input - Updated stream group fields; `id` identifies the row to update.
 * @returns True if a group was actually updated; false if `id` didn't belong to `guildId`.
 */
export async function updateStreamGroup(input: UpdateStreamGroupInput): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE stream_group SET name=?, discord_channel=?, live_message=?, new_game_message=?, multi_twitch=?, delete_old_posts=?
     WHERE id=? AND guild_id=?`,
    [...streamGroupParams(input), input.id, input.guildId],
  );
  return result.affectedRows > 0;
}

/**
 * Return one guild's streamers with their group name, ordered by group then
 * Twitch name (flat view for the admin panel).
 * @param guildId - Guild whose streamers to fetch.
 * @returns The guild's streamers.
 */
export async function getStreamersForGuild(guildId: string): Promise<DbStreamer[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.discord_id, s.group_id,
            u.twitch_name, u.discord_name,
            g.name AS group_name
     FROM streamer s
     JOIN \`user\` u ON u.discord_id = s.discord_id
     JOIN stream_group g ON s.group_id = g.id
     WHERE g.guild_id = ?
     ORDER BY g.name, u.twitch_name`,
    [guildId],
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

/**
 * Return every streamer across every guild with their full group
 * configuration, ordered by group then Twitch name. Used by twitchMonitor,
 * which polls and posts live announcements for all guilds at once — the live
 * announcement itself is already guild-scoped via each group's Discord
 * channel ID, so this read intentionally isn't filtered by guild.
 *
 * @returns Every streamer row across all guilds, with its full group configuration attached.
 */
export async function getAllStreamersWithGroups(): Promise<DbStreamerFull[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT s.id, s.discord_id, s.group_id,
            u.twitch_name,
            s.discord_message_id, s.discord_channel_id, s.live_game,
            g.guild_id, g.name AS group_name, g.discord_channel, g.live_message, g.new_game_message,
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
    group: buildStreamGroup({
      id: r.group_id,
      guild_id: r.guild_id,
      name: r.group_name,
      discord_channel: r.discord_channel,
      live_message: r.live_message,
      new_game_message: r.new_game_message,
      multi_twitch: r.multi_twitch,
      delete_old_posts: r.delete_old_posts,
    }),
  }));
}

/**
 * Add a streamer to a stream group. Throws if `groupId` doesn't belong to
 * `guildId`, preventing one guild from adding a streamer to another's group.
 * The ownership check and insert are done as a single `INSERT ... SELECT`
 * so the two can't race with a concurrent deletion of the group.
 *
 * @param discordId - Discord snowflake of the user to register as a streamer.
 * @param groupId - ID of the stream group to add the streamer to.
 * @param guildId - Guild the caller is acting in; `groupId` must belong to it.
 * @returns Resolves once the row is inserted; throws if `groupId` isn't in `guildId`.
 */
export async function addStreamer(discordId: string, groupId: number, guildId: string): Promise<void> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    'INSERT INTO streamer (discord_id, group_id) SELECT ?, ? FROM stream_group WHERE id = ? AND guild_id = ?',
    [discordId, groupId, groupId, guildId],
  );
  if (result.affectedRows === 0) {
    throw new Error(`Stream group ${groupId} does not belong to guild ${guildId}`);
  }
}

/**
 * Remove a streamer row by its DB ID. A no-op if the streamer's group doesn't
 * belong to `guildId`, preventing one guild from removing another's streamer.
 *
 * @param id - Primary key of the streamer row to delete.
 * @param guildId - Guild the caller is acting in.
 * @returns True if a streamer was actually deleted; false if `id`'s group didn't belong to `guildId`.
 */
export async function removeStreamer(id: number, guildId: string): Promise<boolean> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `DELETE s FROM streamer s JOIN stream_group g ON s.group_id = g.id WHERE s.id = ? AND g.guild_id = ?`,
    [id, guildId],
  );
  return result.affectedRows > 0;
}

/**
 * Deletes a stream group together with all of its streamers, as a single
 * transaction — if the group delete fails after the streamers are already
 * gone (or vice versa), the whole operation rolls back instead of leaving the
 * group orphaned from its streamers while the caller reports failure. A
 * no-op (returns false, nothing deleted) if `groupId` doesn't belong to
 * `guildId`.
 *
 * @param groupId - ID of the stream group to remove, along with its streamers.
 * @param guildId - Guild the caller is acting in; the group must belong to it.
 * @returns True if the group was actually deleted; false if it didn't belong to `guildId`.
 */
export async function removeStreamGroupAndStreamers(groupId: number, guildId: string): Promise<boolean> {
  return withTransaction(async (conn) => {
    await conn.execute(
      `DELETE s FROM streamer s JOIN stream_group g ON s.group_id = g.id WHERE s.group_id = ? AND g.guild_id = ?`,
      [groupId, guildId],
    );
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      'DELETE FROM stream_group WHERE id = ? AND guild_id = ?', [groupId, guildId],
    );
    return result.affectedRows > 0;
  });
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
 * Clear a streamer's live post state, nulling the stored message, channel, and game — but only
 * if `discord_message_id` still matches `expectedMessageId`. Guards against a delayed offline
 * check (e.g. one superseded by a newer same-login operation after its lock timed out — see
 * `twitchMonitorOffline.ts`'s `runOfflineCheck`) clearing a *newer* `setStreamerLive` write that
 * landed first: by the time this call's own `clearStreamerLive` finally runs, the row's
 * `discord_message_id` no longer matches what this call captured before it started cleaning up,
 * so the UPDATE's WHERE clause matches no rows and the newer live state survives untouched.
 * @param id - DB row ID of the streamer to mark as offline.
 * @param expectedMessageId - The `discord_message_id` this call expects to still be current
 *   (typically the message being cleaned up), or `null` if the caller has no live post to guard
 *   against (e.g. it never had a `discord_message_id` to begin with).
 */
export async function clearStreamerLive(id: number, expectedMessageId: string | null): Promise<void> {
  await getPool().execute(
    expectedMessageId === null
      ? 'UPDATE streamer SET discord_message_id=NULL, discord_channel_id=NULL, live_game=NULL WHERE id=? AND discord_message_id IS NULL'
      : 'UPDATE streamer SET discord_message_id=NULL, discord_channel_id=NULL, live_game=NULL WHERE id=? AND discord_message_id=?',
    expectedMessageId === null ? [id] : [id, expectedMessageId],
  );
}
