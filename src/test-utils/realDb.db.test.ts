import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from '../db/pool';
import { workerDatabase } from './realDb';
import { TEST_DATABASE_PREFIX } from './realDbSettings';

// The real-MySQL harness itself (npm run test:db). The two "empty" tests rely on running in
// file order: the first leaves rows behind for the harness to clear before the second.

const SNOWFLAKE_ABOVE_MAX_SAFE_INTEGER = '1234567890123456789';

/** Counts the rows in the `user` table. */
async function userCount(): Promise<number> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM `user`');
  // COUNT(*) over a table a single test fills with a row or two: far below Number.MAX_SAFE_INTEGER.
  return Number(rows[0]!.n);
}

describe('real-database harness', () => {
  it("points the app's pool at the worker's scratch database", async () => {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
    expect(rows[0]!.name).toBe(workerDatabase().name);
    expect(workerDatabase().name.startsWith(TEST_DATABASE_PREFIX)).toBe(true);
  });

  it('returns BIGINT columns as exact strings, like production', async () => {
    await getPool().execute('INSERT INTO `user` (discord_id) VALUES (?)', [SNOWFLAKE_ABOVE_MAX_SAFE_INTEGER]);
    const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT discord_id FROM `user`');
    expect(rows).toEqual([{ discord_id: SNOWFLAKE_ABOVE_MAX_SAFE_INTEGER }]);
  });

  it('empties the tables a previous test wrote to', async () => {
    expect(await userCount()).toBe(0);
  });

  it('keeps the migration record between tests', async () => {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
