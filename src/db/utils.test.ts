import { describe, it, expect, vi } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));

import { fromBit, affectedOrExists, rowExists, hashesMatch, getRowCount } from './utils';
import { getPool } from './pool';

describe('fromBit', () => {
  it('returns true for Buffer with first byte 1', () => {
    expect(fromBit(Buffer.from([1]))).toBe(true);
  });

  it('returns false for Buffer with first byte 0', () => {
    expect(fromBit(Buffer.from([0]))).toBe(false);
  });

  it('returns true for numeric 1', () => {
    expect(fromBit(1)).toBe(true);
  });

  it('returns false for numeric 0', () => {
    expect(fromBit(0)).toBe(false);
  });

  it('returns true for string "1" (loose equality)', () => {
    expect(fromBit('1')).toBe(true);
  });

  it('returns false for null', () => {
    expect(fromBit(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(fromBit(undefined)).toBe(false);
  });
});

describe('affectedOrExists', () => {
  it('returns true without calling existsCheck when affectedRows > 0', async () => {
    const existsCheck = vi.fn().mockResolvedValue(false);
    const result = await affectedOrExists(1, existsCheck);
    expect(result).toBe(true);
    expect(existsCheck).not.toHaveBeenCalled();
  });

  it('calls existsCheck and returns its result when affectedRows is 0', async () => {
    const existsCheck = vi.fn().mockResolvedValue(true);
    const result = await affectedOrExists(0, existsCheck);
    expect(result).toBe(true);
    expect(existsCheck).toHaveBeenCalledOnce();
  });

  it('returns false when affectedRows is 0 and existsCheck resolves false', async () => {
    const existsCheck = vi.fn().mockResolvedValue(false);
    const result = await affectedOrExists(0, existsCheck);
    expect(result).toBe(false);
  });
});

describe('rowExists', () => {
  it('returns true when the query returns a row', async () => {
    const executor = { execute: vi.fn().mockResolvedValue([[{ '1': 1 }], []]) };
    const result = await rowExists(executor as any, 'counter', 'id', 5);
    expect(result).toBe(true);
  });

  it('returns false when the query returns no rows', async () => {
    const executor = { execute: vi.fn().mockResolvedValue([[], []]) };
    const result = await rowExists(executor as any, 'counter', 'id', 5);
    expect(result).toBe(false);
  });

  it('builds SQL from the given table/column and passes value as the only param', async () => {
    const executor = { execute: vi.fn().mockResolvedValue([[], []]) };
    await rowExists(executor as any, 'custom_command', 'command_id', 42);
    const [sql, params] = executor.execute.mock.calls[0];
    expect(sql).toBe('SELECT 1 FROM custom_command WHERE command_id = ? LIMIT 1');
    expect(params).toEqual([42]);
  });

  it('accepts a string value (e.g. a BIGINT id passed as a string)', async () => {
    const executor = { execute: vi.fn().mockResolvedValue([[{ '1': 1 }], []]) };
    const result = await rowExists(executor as any, 'sfxtrigger', 'id', '123456789012345');
    expect(result).toBe(true);
    expect(executor.execute.mock.calls[0][1]).toEqual(['123456789012345']);
  });

  it('rejects a table name containing non-identifier characters without querying', async () => {
    const executor = { execute: vi.fn() };
    await expect(rowExists(executor as any, 'counter; DROP TABLE user', 'id', 5)).rejects.toThrow('Invalid input');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('rejects a column name containing non-identifier characters without querying', async () => {
    const executor = { execute: vi.fn() };
    await expect(rowExists(executor as any, 'counter', 'id = 1 OR 1=1 -- ', 5)).rejects.toThrow('Invalid input');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('accepts a table/column made only of letters, digits, and underscores', async () => {
    const executor = { execute: vi.fn().mockResolvedValue([[], []]) };
    await expect(rowExists(executor as any, 'custom_command_2', 'command_id_2', 1)).resolves.toBe(false);
  });
});

describe('getRowCount', () => {
  it('converts the BIGINT-string COUNT(*) result to a number', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ count: '3' }], []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getRowCount('counter')).toBe(3);
  });

  it('passes through a real number result unchanged', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ count: 0 }], []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await getRowCount('sfxtrigger')).toBe(0);
  });

  it('builds SQL from the given table name', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ count: '0' }], []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getRowCount('custom_command');
    expect(pool.execute.mock.calls[0][0]).toBe('SELECT COUNT(*) AS count FROM custom_command');
  });

  it('rejects a table name containing non-identifier characters without querying', async () => {
    const pool = { execute: vi.fn() };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(getRowCount('counter; DROP TABLE user')).rejects.toThrow('Invalid input');
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('hashesMatch', () => {
  it('returns true for identical hex hashes', () => {
    const hash = 'a'.repeat(64);
    expect(hashesMatch(hash, hash)).toBe(true);
  });

  it('returns false for hashes that differ', () => {
    expect(hashesMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('returns true when only hex casing differs — both decode to the same bytes, so a row matched loosely by a case-insensitive column collation still validates correctly', () => {
    expect(hashesMatch('ABCDEF'.repeat(4), 'abcdef'.repeat(4))).toBe(true);
  });

  it('returns false for genuinely different bytes even if hex-decodable and same length', () => {
    expect(hashesMatch('aa'.repeat(32), 'ab'.repeat(32))).toBe(false);
  });

  it('returns false for hashes of different lengths without throwing', () => {
    expect(hashesMatch('ab', 'abcd')).toBe(false);
  });
});
