import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { recordStreamerEvent } from './eventLog';
import { insertRow } from '../test-utils/realDbRows';

// recordStreamerEvent's redemption dedupe against a real MySQL (npm run test:db): a retried
// redemption hits uq_streamer_event_log_redemption and is skipped, while events without a
// redemption id (NULL, which a unique index doesn't compare) are all recorded.

async function eventCount(): Promise<number> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM streamer_event_log');
  // COUNT(*) over the handful of rows one test inserts: far below Number.MAX_SAFE_INTEGER.
  return Number(rows[0]!.n);
}

describe('recordStreamerEvent (real MySQL)', () => {
  it('records a redemption once, returning null for a retry of the same redemption id', async () => {
    const streamerId = Number((await insertRow('streamer')).id);

    expect(await recordStreamerEvent(streamerId, 'redemption', 'Viewer', 'Hydrate', 'redemption-1')).toEqual(expect.any(Number));
    expect(await recordStreamerEvent(streamerId, 'redemption', 'Viewer', 'Hydrate', 'redemption-1')).toBeNull();
    expect(await eventCount()).toBe(1);
  });

  it('records every event that has no redemption id', async () => {
    const streamerId = Number((await insertRow('streamer')).id);

    await recordStreamerEvent(streamerId, 'follow', 'Viewer', null);
    await recordStreamerEvent(streamerId, 'follow', 'Viewer', null);

    expect(await eventCount()).toBe(2);
  });
});
