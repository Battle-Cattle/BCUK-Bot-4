import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getOverridesForGuild,
  getAllOverrides,
  upsertOverride,
  removeOverride,
} from './guildCommandOverrides';

function makePool() {
  return { execute: vi.fn().mockResolvedValue([[], []]) };
}

let pool: ReturnType<typeof makePool>;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makePool();
  vi.mocked(getPool).mockReturnValue(pool as never);
});

describe('getOverridesForGuild', () => {
  it('maps rows, stringifies guild_id, and decodes BIT is_disabled via real fromBit', async () => {
    // MySQL BIT(1) columns arrive as single-byte Buffers, not plain integers.
    // Using real Buffer fixtures here validates the actual fromBit decoding path.
    pool.execute.mockResolvedValueOnce([
      [
        { guild_id: 111, command_id: 5, is_disabled: Buffer.from([1]), output: null },
        { guild_id: 111, command_id: 6, is_disabled: Buffer.from([0]), output: 'custom text' },
      ],
      [],
    ]);

    const result = await getOverridesForGuild('111');

    expect(result).toEqual([
      { guild_id: '111', command_id: 5, is_disabled: true, output: null },
      { guild_id: '111', command_id: 6, is_disabled: false, output: 'custom text' },
    ]);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('WHERE guild_id = ?'), ['111']);
  });
});

describe('getAllOverrides', () => {
  it('reads every override row with no guild filter', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    await getAllOverrides();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(params).toBeUndefined();
  });
});

describe('upsertOverride', () => {
  it('upserts disable + output, coercing the boolean to TINYINT', async () => {
    await upsertOverride('111', 5, { isDisabled: true, output: 'hi' });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO guild_command_override');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE is_disabled = new_override.is_disabled, output = new_override.output');
    expect(params).toEqual(['111', 5, 1, 'hi']);
  });

  it('passes null output through unchanged', async () => {
    await upsertOverride('111', 5, { isDisabled: false, output: null });
    expect(pool.execute.mock.calls[0][1]).toEqual(['111', 5, 0, null]);
  });
});

describe('removeOverride', () => {
  it('deletes the override row', async () => {
    await removeOverride('111', 5);
    expect(pool.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM guild_command_override'),
      ['111', 5],
    );
  });
});
