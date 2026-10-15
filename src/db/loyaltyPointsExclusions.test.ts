import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { makeMockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { normalizeExcludedUsername, getExclusions, getAllExclusions, addExclusion, removeExclusion } from './loyaltyPointsExclusions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeExcludedUsername', () => {
  it('trims and lowercases a login', () => {
    expect(normalizeExcludedUsername('  PokemonCommunityGame ')).toBe('pokemoncommunitygame');
  });
});

describe('getExclusions', () => {
  it('returns the streamer\'s excluded logins in query order', async () => {
    const pool = makeMockPool({ rows: [{ twitch_username: 'bcuk_bot' }, { twitch_username: 'pokemoncommunitygame' }] });
    vi.mocked(getPool).mockReturnValue(pool as any);

    expect(await getExclusions(7)).toEqual(['bcuk_bot', 'pokemoncommunitygame']);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('ORDER BY twitch_username'), [7]);
  });

  it('returns an empty array when nothing is excluded', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [] }) as any);
    expect(await getExclusions(7)).toEqual([]);
  });
});

describe('getAllExclusions', () => {
  it('maps every row to a (streamer, login) pair', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [{ streamer_id: 1, twitch_username: 'a' }, { streamer_id: 2, twitch_username: 'b' }] }) as any);
    expect(await getAllExclusions()).toEqual([{ streamerId: 1, twitchUsername: 'a' }, { streamerId: 2, twitchUsername: 'b' }]);
  });
});

describe('addExclusion', () => {
  it('inserts the normalized login, ignoring duplicates', async () => {
    const pool = makeMockPool({});
    vi.mocked(getPool).mockReturnValue(pool as any);

    await addExclusion(7, ' SomeBot ');

    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT IGNORE INTO loyalty_points_exclusion'), [7, 'somebot']);
  });
});

describe('removeExclusion', () => {
  it('deletes the normalized login for that streamer only', async () => {
    const pool = makeMockPool({});
    vi.mocked(getPool).mockReturnValue(pool as any);

    await removeExclusion(7, 'SomeBot');

    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM loyalty_points_exclusion'), [7, 'somebot']);
  });
});
