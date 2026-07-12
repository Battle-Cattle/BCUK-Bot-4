import { describe, it, expect } from 'vitest';
import { makeMockConnection, makeMockPool } from './mockMysqlPool';

describe('makeMockConnection', () => {
  it('defaults execute to resolve an empty rows/meta tuple', async () => {
    const conn = makeMockConnection();
    await expect(conn.execute('SELECT 1')).resolves.toEqual([[], []]);
  });

  it('defaults beginTransaction/commit/rollback to resolve undefined and release to a plain spy', async () => {
    const conn = makeMockConnection();
    await expect(conn.beginTransaction()).resolves.toBeUndefined();
    await expect(conn.commit()).resolves.toBeUndefined();
    await expect(conn.rollback()).resolves.toBeUndefined();
    conn.release();
    expect(conn.release).toHaveBeenCalledOnce();
  });

  it('applies overrides wholesale for a given field', async () => {
    const conn = makeMockConnection({ execute: makeMockConnection().execute });
    conn.execute.mockResolvedValueOnce([[{ id: 1 }], []]);
    await expect(conn.execute('SELECT 1')).resolves.toEqual([[{ id: 1 }], []]);
  });
});

describe('makeMockPool', () => {
  it('defaults execute and query to resolve an empty rows/meta tuple', async () => {
    const pool = makeMockPool();
    await expect(pool.execute('SELECT 1')).resolves.toEqual([[], []]);
    await expect(pool.query('SELECT 1')).resolves.toEqual([[], []]);
  });

  it('wraps rows/meta options into the [rows, meta] tuple execute/query resolve to', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const pool = makeMockPool({ rows, meta: { fields: [] } });
    await expect(pool.execute('SELECT 1')).resolves.toEqual([rows, { fields: [] }]);
    await expect(pool.query('SELECT 1')).resolves.toEqual([rows, { fields: [] }]);
  });

  it('uses executeResult verbatim, bypassing the rows/meta wrapping, for ResultSetHeader-shaped results', async () => {
    const pool = makeMockPool({ executeResult: [{ insertId: 42, affectedRows: 1 }, []] });
    await expect(pool.execute('INSERT ...')).resolves.toEqual([{ insertId: 42, affectedRows: 1 }, []]);
  });

  it('getConnection resolves to a fake connection also exposed as _conn', async () => {
    const pool = makeMockPool();
    await expect(pool.getConnection()).resolves.toBe(pool._conn);
  });

  it('accepts a pre-built connection to back getConnection()/_conn', async () => {
    const connection = makeMockConnection();
    connection.execute.mockResolvedValueOnce([[{ id: 9 }], []]);
    const pool = makeMockPool({ connection });
    expect(pool._conn).toBe(connection);
    await expect((await pool.getConnection()).execute()).resolves.toEqual([[{ id: 9 }], []]);
  });
});
