import mysql from 'mysql2/promise';
import { getPool } from './pool';

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

function mapVideo(r: mysql.RowDataPacket): OverlayVideo {
  return {
    id: r.id,
    streamer_id: r.streamer_id,
    name: r.name,
    filename: r.filename,
    created_at: r.created_at,
  };
}

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

export async function addVideo(streamerId: number, name: string, filename: string): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO overlay_video (streamer_id, name, filename) VALUES (?, ?, ?)`,
    [streamerId, name, filename],
  );
  return result.insertId;
}

export async function getVideoById(videoId: number, streamerId: number): Promise<OverlayVideo | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, streamer_id, name, filename, created_at
     FROM overlay_video
     WHERE id = ? AND streamer_id = ?`,
    [videoId, streamerId],
  );
  return rows.length === 0 ? null : mapVideo(rows[0]);
}

export async function deleteVideo(videoId: number, streamerId: number): Promise<string | null> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT filename FROM overlay_video WHERE id = ? AND streamer_id = ?`,
      [videoId, streamerId],
    );
    if (rows.length === 0) {
      await conn.rollback();
      return null;
    }
    const filename: string = rows[0].filename;
    const [del] = await conn.execute<mysql.ResultSetHeader>(
      `DELETE FROM overlay_video WHERE id = ? AND streamer_id = ?`, [videoId, streamerId],
    );
    if (del.affectedRows === 0) {
      await conn.rollback();
      return null;
    }
    await conn.commit();
    return filename;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

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

export async function upsertReward(streamerId: number, twitchRewardId: string): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO overlay_reward (streamer_id, twitch_reward_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [streamerId, twitchRewardId],
  );
  return result.insertId;
}

export async function setRewardVideos(
  rewardId: number,
  streamerId: number,
  videos: Array<{ videoId: number; weight: number }>,
): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    // Verify reward belongs to this streamer
    const [check] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM overlay_reward WHERE id = ? AND streamer_id = ?`,
      [rewardId, streamerId],
    );
    if (check.length === 0) {
      await conn.rollback();
      return;
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
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function deleteReward(rewardId: number, streamerId: number): Promise<void> {
  await getPool().execute(
    `DELETE FROM overlay_reward WHERE id = ? AND streamer_id = ?`,
    [rewardId, streamerId],
  );
}

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
