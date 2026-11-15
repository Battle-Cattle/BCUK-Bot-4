import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { addVideo, saveRewardWithVideos } from './overlayVideos';
import { insertRow } from '../test-utils/realDbRows';

// saveRewardWithVideos against a real MySQL (npm run test:db): saving the same Twitch reward again
// reuses its row (ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) hands back the existing id) and
// replaces its videos.

async function rewardVideos(rewardId: number): Promise<number[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>('SELECT video_id FROM overlay_reward_video WHERE reward_id = ? ORDER BY video_id', [rewardId]);
  return rows.map((r) => Number(r.video_id));
}

describe('saveRewardWithVideos (real MySQL)', () => {
  it('reuses the reward row for the same Twitch reward and replaces its videos', async () => {
    const streamerId = Number((await insertRow('streamer')).id);
    const first = await addVideo(streamerId, 'First', 'first.mp4');
    const second = await addVideo(streamerId, 'Second', 'second.mp4');

    const rewardId = await saveRewardWithVideos(streamerId, 'reward-1', [{ videoId: first, weight: 1 }]);
    expect(await rewardVideos(rewardId)).toEqual([first]);

    expect(await saveRewardWithVideos(streamerId, 'reward-1', [{ videoId: second, weight: 2 }])).toBe(rewardId);
    expect(await rewardVideos(rewardId)).toEqual([second]);
    const [rewards] = await getPool().query<mysql.RowDataPacket[]>('SELECT id FROM overlay_reward');
    expect(rewards).toEqual([{ id: rewardId }]);
  });
});
