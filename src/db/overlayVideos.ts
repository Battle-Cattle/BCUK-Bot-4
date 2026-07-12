import mysql from 'mysql2/promise';
import { getPool, withTransaction } from './pool';

export interface OverlayVideo {
  id: number;
  streamer_id: number;
  name: string;
  filename: string;
  created_at: Date;
}

export interface OverlayReward {
  id: number;
  streamer_id: number;
  twitch_reward_id: string;
}

export interface OverlayRewardWithVideos extends OverlayReward {
  videos: Array<{ video_id: number; weight: number; name: string; filename: string }>;
}

export interface OverlayWeightedVideo {
  file: string;
  weight: number;
}

/** Maps a raw `overlay_video` row to an {@link OverlayVideo}. */
function mapVideo(r: mysql.RowDataPacket): OverlayVideo {
  return {
    id: r.id,
    streamer_id: r.streamer_id,
    name: r.name,
    filename: r.filename,
    created_at: r.created_at,
  };
}

/**
 * Fetches all overlay videos belonging to a streamer, newest first.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The streamer's overlay videos.
 */
export async function getVideosForStreamer(streamerId: number): Promise<OverlayVideo[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, name, filename, created_at
     FROM overlay_video
     WHERE streamer_id = ?
     ORDER BY created_at DESC`,
    [streamerId],
  );
  return rows.map(mapVideo);
}

/**
 * Inserts a new overlay video row.
 * @param streamerId DB row ID of the owning streamer.
 * @param name Display name for the video.
 * @param filename Stored filename of the video.
 * @returns The new row's primary key.
 */
export async function addVideo(streamerId: number, name: string, filename: string): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO overlay_video (streamer_id, name, filename) VALUES (?, ?, ?)`,
    [streamerId, name, filename],
  );
  return result.insertId;
}

/**
 * Looks up an overlay video by id, scoped to the owning streamer.
 * @param videoId Primary key of the `overlay_video` row.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The video, or null if no matching row exists.
 */
export async function getVideoById(videoId: number, streamerId: number): Promise<OverlayVideo | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, name, filename, created_at
     FROM overlay_video
     WHERE id = ? AND streamer_id = ?`,
    [videoId, streamerId],
  );
  return rows.length === 0 ? null : mapVideo(rows[0]);
}

/**
 * Delete an overlay video row, scoped to the owning streamer.
 * @param videoId Primary key of the `overlay_video` row.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The deleted row's filename (for filesystem cleanup), or null if no matching row existed.
 */
export async function deleteVideo(videoId: number, streamerId: number): Promise<string | null> {
  class VideoNotFound extends Error {}
  try {
    return await withTransaction(async (conn) => {
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT filename FROM overlay_video WHERE id = ? AND streamer_id = ?`,
        [videoId, streamerId],
      );
      if (rows.length === 0) {
        throw new VideoNotFound();
      }
      const filename: string = rows[0].filename;
      const [del] = await conn.execute<mysql.ResultSetHeader>(
        `DELETE FROM overlay_video WHERE id = ? AND streamer_id = ?`, [videoId, streamerId],
      );
      if (del.affectedRows === 0) {
        throw new VideoNotFound();
      }
      return filename;
    });
  } catch (err) {
    if (err instanceof VideoNotFound) return null;
    throw err;
  }
}

/**
 * Fetches all overlay rewards belonging to a streamer, each with its assigned weighted videos.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The streamer's overlay rewards with their assigned videos.
 */
export async function getRewardsForStreamer(streamerId: number): Promise<OverlayRewardWithVideos[]> {
  const [rewardRows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT r.id, r.streamer_id, r.twitch_reward_id,
            rv.video_id, rv.weight, v.name, v.filename
     FROM overlay_reward r
     LEFT JOIN overlay_reward_video rv ON rv.reward_id = r.id
     LEFT JOIN overlay_video v ON v.id = rv.video_id
     WHERE r.streamer_id = ?
     ORDER BY r.id, rv.video_id`,
    [streamerId],
  );

  const rewardMap = new Map<number, OverlayRewardWithVideos>();
  for (const row of rewardRows) {
    if (!rewardMap.has(row.id)) {
      rewardMap.set(row.id, {
        id: row.id,
        streamer_id: row.streamer_id,
        twitch_reward_id: row.twitch_reward_id,
        videos: [],
      });
    }
    if (row.video_id != null) {
      rewardMap.get(row.id)!.videos.push({
        video_id: row.video_id,
        weight: row.weight,
        name: row.name,
        filename: row.filename,
      });
    }
  }
  return Array.from(rewardMap.values());
}

/**
 * Inserts an overlay reward for a streamer's Twitch channel-point reward, or returns the existing
 * row's id if one already exists for this streamer+reward.
 * @param streamerId DB row ID of the owning streamer.
 * @param twitchRewardId Twitch channel-point reward id.
 * @returns The reward row's primary key.
 */
export async function upsertReward(streamerId: number, twitchRewardId: string): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO overlay_reward (streamer_id, twitch_reward_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [streamerId, twitchRewardId],
  );
  return result.insertId;
}

/**
 * Replaces the set of videos assigned to a reward with `videos`, scoped to the owning streamer.
 * A no-op if `rewardId` doesn't belong to `streamerId`. Throws if any video in `videos` doesn't
 * belong to `streamerId`, rolling back the whole replacement.
 * @param rewardId Primary key of the `overlay_reward` row.
 * @param streamerId DB row ID of the owning streamer.
 * @param videos The videos (and their weights) to assign to the reward.
 */
export async function setRewardVideos(
  rewardId: number,
  streamerId: number,
  videos: Array<{ videoId: number; weight: number }>,
): Promise<void> {
  class RewardNotFound extends Error {}
  try {
    await withTransaction(async (conn) => {
      // Verify reward belongs to this streamer
      const [check] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM overlay_reward WHERE id = ? AND streamer_id = ?`,
        [rewardId, streamerId],
      );
      if (check.length === 0) {
        throw new RewardNotFound();
      }
      await conn.execute(`DELETE FROM overlay_reward_video WHERE reward_id = ?`, [rewardId]);
      for (const v of videos) {
        const [insert] = await conn.execute<mysql.ResultSetHeader>(
          `INSERT INTO overlay_reward_video (reward_id, video_id, weight)
           SELECT ?, ov.id, ?
           FROM overlay_video ov
           WHERE ov.id = ? AND ov.streamer_id = ?`,
          [rewardId, Math.max(1, v.weight), v.videoId, streamerId],
        );
        if (insert.affectedRows !== 1) {
          throw new Error(`Video ${v.videoId} does not belong to streamer ${streamerId}`);
        }
      }
    });
  } catch (err) {
    if (err instanceof RewardNotFound) return;
    throw err;
  }
}

/**
 * Deletes an overlay reward row, scoped to the owning streamer.
 * @param rewardId Primary key of the `overlay_reward` row.
 * @param streamerId DB row ID of the owning streamer.
 */
export async function deleteReward(rewardId: number, streamerId: number): Promise<void> {
  await getPool().execute(
    `DELETE FROM overlay_reward WHERE id = ? AND streamer_id = ?`,
    [rewardId, streamerId],
  );
}

/**
 * Fetches the weighted videos assigned to a streamer's Twitch channel-point reward, for use when
 * randomly selecting a video to play.
 * @param twitchRewardId Twitch channel-point reward id.
 * @param streamerId DB row ID of the owning streamer.
 * @returns The reward's assigned videos with their filenames and weights.
 */
export async function getVideosForReward(
  twitchRewardId: string,
  streamerId: number,
): Promise<OverlayWeightedVideo[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT v.filename, rv.weight
     FROM overlay_reward r
     JOIN overlay_reward_video rv ON rv.reward_id = r.id
     JOIN overlay_video v ON v.id = rv.video_id
     WHERE r.twitch_reward_id = ? AND r.streamer_id = ?`,
    [twitchRewardId, streamerId],
  );
  return rows.map((r) => ({ file: r.filename, weight: r.weight }));
}
