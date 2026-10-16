import { describe, it, expect, vi, beforeEach } from 'vitest';

// withTransaction/withTransactionOrNotFound are reimplemented here so this test doesn't pull in
// pool.ts's real config chain (see loyaltyPoints.test.ts).
vi.mock('./pool', () => {
  const getPool = vi.fn();
  const withTransaction = async (work: (conn: unknown) => Promise<unknown>) => {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  };
  const signal = new Error('not found');
  return {
    getPool,
    withTransaction,
    withTransactionOrNotFound: async (work: (conn: unknown, nf: () => never) => Promise<unknown>) => {
      try {
        return await withTransaction((conn) => work(conn, () => { throw signal; }));
      } catch (err) {
        if (err === signal) return null;
        throw err;
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('./commandWriteGuard', () => ({ runSerializedCommandWrite: vi.fn() }));

import { makeMockPool, type MockPool } from '../test-utils/mockMysqlPool';
import { getPool } from './pool';
import { runSerializedCommandWrite } from './commandWriteGuard';
import {
  addAdvancedCommand, updateAdvancedCommand, setAdvancedCommandEnabled, removeAdvancedCommand,
  listAdvancedCommands, getAdvancedCommand, getAllAdvancedCommandChatRoutes,
  saveAdvancedCommandEffects, setAdvancedCommandAlertAsset, AdvancedCommandConflictError,
} from './advancedCommands';
import type { AdvancedCommandSettings } from './advancedCommandValidation';

const SETTINGS: AdvancedCommandSettings = {
  name: 'Hydrate',
  triggerString: '!Hydrate',
  isEnabled: true,
  response: 'Drink up {user}',
  pointCost: 100,
  priceStep: 10,
  maxCost: 200,
  globalCooldownSeconds: 30,
  userCooldownSeconds: 60,
  minRole: 'subscriber',
  liveOnly: true,
  maxUsesPerStream: 5,
  maxUsesPerUserPerStream: 1,
  companionEnabled: true,
};

const ROW = {
  id: 7, streamer_id: 3, name: 'Hydrate', trigger_string: '!hydrate', is_enabled: 1, response: null,
  point_cost: 100, price_step: 0, max_cost: null, global_cooldown_seconds: 0, user_cooldown_seconds: 0,
  min_role: 'everyone', live_only: 0, max_uses_per_stream: null, max_uses_per_user_per_stream: null, companion_enabled: 1,
};

let pool: MockPool;

beforeEach(() => {
  vi.clearAllMocks();
  pool = makeMockPool();
  vi.mocked(getPool).mockReturnValue(pool as any);
  vi.mocked(runSerializedCommandWrite).mockImplementation(async (_cmds, _opts, write) => write(pool._conn as any));
});

describe('addAdvancedCommand', () => {
  it('inserts the normalised settings under the command-namespace guard', async () => {
    pool._conn.execute.mockResolvedValueOnce([{ insertId: 12 }, []]);
    expect(await addAdvancedCommand(3, SETTINGS)).toBe(12);

    expect(runSerializedCommandWrite).toHaveBeenCalledWith('!hydrate', undefined, expect.any(Function), {
      includeCustomCommandTable: true, includeCounterTable: true, includeAdvancedCommandTable: false,
    });
    const [sql, params] = pool._conn.execute.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO advanced_command');
    expect(params).toEqual([3, 'Hydrate', '!hydrate', 1, 'Drink up {user}', 100, 10, 200, 30, 60, 'subscriber', 1, 5, 1, 1]);
  });

  it('skips the guard for a Stream Deck-only command', async () => {
    pool._conn.execute.mockResolvedValueOnce([{ insertId: 13 }, []]);
    expect(await addAdvancedCommand(3, { ...SETTINGS, triggerString: null })).toBe(13);
    expect(runSerializedCommandWrite).not.toHaveBeenCalled();
    expect(pool._conn.commit).toHaveBeenCalled();
  });

  it.each([
    ["Duplicate entry '3-Hydrate' for key 'advanced_command.uq_advanced_command_name'", 'name'],
    ["Duplicate entry '3-!hydrate' for key 'advanced_command.uq_advanced_command_trigger'", 'trigger'],
  ])('maps a duplicate-key error (%s) to a conflict on %s', async (message, field) => {
    pool._conn.execute.mockRejectedValueOnce(Object.assign(new Error(message), { code: 'ER_DUP_ENTRY' }));
    const error = await addAdvancedCommand(3, SETTINGS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AdvancedCommandConflictError);
    expect((error as AdvancedCommandConflictError).field).toBe(field);
  });

  it('passes other errors through', async () => {
    pool._conn.execute.mockRejectedValueOnce(new Error('boom'));
    await expect(addAdvancedCommand(3, SETTINGS)).rejects.toThrow('boom');
  });
});

describe('updateAdvancedCommand', () => {
  it('updates scoped to the streamer and reports whether the row existed', async () => {
    pool._conn.execute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect(await updateAdvancedCommand(3, 7, SETTINGS)).toBe(true);
    const [sql, params] = pool._conn.execute.mock.calls[0]!;
    expect(sql).toContain('WHERE id = ? AND streamer_id = ?');
    expect(params.slice(-2)).toEqual([7, 3]);

    pool._conn.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    expect(await updateAdvancedCommand(3, 7, SETTINGS)).toBe(false);
  });
});

describe('setAdvancedCommandEnabled', () => {
  it('toggles the current state when no state is given', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ is_enabled: 1 }], []]).mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect(await setAdvancedCommandEnabled(3, 7)).toBe(false);
    expect(pool._conn.execute.mock.calls[1]![1]).toEqual([0, 7]);
  });

  it('sets an explicit state', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ is_enabled: 1 }], []]).mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect(await setAdvancedCommandEnabled(3, 7, true)).toBe(true);
  });

  it('returns null for another streamer\'s or a missing command', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await setAdvancedCommandEnabled(3, 7)).toBeNull();
    expect(pool._conn.rollback).toHaveBeenCalled();
  });
});

describe('removeAdvancedCommand', () => {
  it('deletes the command and returns its alert asset filenames', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ image_filename: 'a.png', sound_filename: null }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    expect(await removeAdvancedCommand(3, 7)).toEqual(['a.png']);
    expect(pool._conn.execute.mock.calls[1]![0]).toContain('DELETE FROM advanced_command');
  });

  it('returns null when nothing matches', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await removeAdvancedCommand(3, 7)).toBeNull();
  });
});

describe('reads', () => {
  it('lists a streamer\'s commands with params, videos and alert attached', async () => {
    pool.execute
      .mockResolvedValueOnce([[ROW], []])
      .mockResolvedValueOnce([[{ command_id: 7, param_key: 'color', param_value: 'red' }], []])
      .mockResolvedValueOnce([[{ command_id: 7, video_id: 2, weight: 3, name: 'Splash', filename: 'v.mp4' }], []])
      .mockResolvedValueOnce([[{
        command_id: 7, message_template: 'Hi', image_filename: null, sound_filename: 's.mp3', duration_ms: 4000, text_animation: 'wave',
      }], []]);

    const [command] = await listAdvancedCommands(3);
    expect(command).toMatchObject({
      id: 7, streamerId: 3, triggerString: '!hydrate', isEnabled: true, liveOnly: false, companionEnabled: true,
      params: [{ key: 'color', value: 'red' }],
      videos: [{ videoId: 2, weight: 3, name: 'Splash', filename: 'v.mp4' }],
      alert: { messageTemplate: 'Hi', imageFilename: null, soundFilename: 's.mp3', durationMs: 4000, textAnimation: 'wave' },
    });
    expect(pool.execute.mock.calls[0]![1]).toEqual([3]);
  });

  it('skips the effect queries when the streamer has no commands', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await listAdvancedCommands(3)).toEqual([]);
    expect(pool.execute).toHaveBeenCalledOnce();
  });

  it('returns null for a command that is not the streamer\'s', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    expect(await getAdvancedCommand(3, 7)).toBeNull();
    expect(pool.execute.mock.calls[0]![1]).toEqual([3, 7]);
  });

  it('loads one command with effects', async () => {
    pool.execute.mockResolvedValueOnce([[ROW], []]).mockResolvedValue([[], []]);
    expect(await getAdvancedCommand(3, 7)).toMatchObject({ id: 7, params: [], videos: [], alert: null });
  });

  it('lists chat routes for enabled, triggered commands on bot-enabled channels', async () => {
    pool.execute.mockResolvedValueOnce([[{ id: 7, streamer_id: 3, trigger_string: '!hydrate', twitch_name: 'Streamer', discord_id: '123' }], []]);
    expect(await getAllAdvancedCommandChatRoutes()).toEqual([
      { commandId: 7, streamerId: 3, triggerString: '!hydrate', twitchName: 'Streamer', discordId: '123' },
    ]);
    expect(pool.execute.mock.calls[0]![0]).toContain('u.is_twitch_bot_enabled = 1');
  });
});

describe('saveAdvancedCommandEffects', () => {
  it('replaces params, videos (owned) and alert in one transaction', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []]) // ownership
      .mockResolvedValueOnce([{}, []]) // delete params
      .mockResolvedValueOnce([{}, []]) // insert params
      .mockResolvedValueOnce([{}, []]) // delete videos
      .mockResolvedValueOnce([[{ id: 2 }], []]) // owned videos
      .mockResolvedValueOnce([{}, []]) // insert videos
      .mockResolvedValueOnce([{}, []]); // upsert alert

    const result = await saveAdvancedCommandEffects(3, 7, {
      params: [{ key: 'color', value: 'red' }],
      videos: [{ videoId: 2, weight: 2 }],
      alert: { messageTemplate: 'Hi', durationMs: 4000, textAnimation: 'none' },
    });
    expect(result).toEqual([]);
    const calls = pool._conn.execute.mock.calls;
    expect(calls[2]![1]).toEqual([7, 'color', 'red']);
    expect(calls[5]![1]).toEqual([7, 2, 2]);
    expect(calls[6]![0]).toContain('INSERT INTO advanced_command_alert');
    expect(calls[6]![0]).not.toContain('image_filename');
    expect(pool._conn.commit).toHaveBeenCalled();
  });

  it('rolls back when a video belongs to another streamer', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([{}, []])
      .mockResolvedValueOnce([[], []]);
    await expect(saveAdvancedCommandEffects(3, 7, { params: [], videos: [{ videoId: 9, weight: 1 }], alert: null }))
      .rejects.toThrow('not owned');
    expect(pool._conn.rollback).toHaveBeenCalled();
  });

  it('removes the alert and returns its orphaned asset filenames', async () => {
    pool._conn.execute
      .mockResolvedValueOnce([[{ id: 7 }], []])
      .mockResolvedValueOnce([{}, []]) // delete params
      .mockResolvedValueOnce([{}, []]) // delete videos
      .mockResolvedValueOnce([[{ image_filename: 'a.gif', sound_filename: 'b.mp3' }], []])
      .mockResolvedValueOnce([{}, []]);
    expect(await saveAdvancedCommandEffects(3, 7, { params: [], videos: [], alert: null })).toEqual(['a.gif', 'b.mp3']);
  });

  it('returns null for a command that is not the streamer\'s', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await saveAdvancedCommandEffects(3, 7, { params: [], videos: [], alert: null })).toBeNull();
  });
});

describe('setAdvancedCommandAlertAsset', () => {
  it('sets the image and returns the previous filename', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ filename: 'old.png' }], []]).mockResolvedValueOnce([{}, []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'image', 'new.png')).toEqual({ previous: 'old.png' });
    expect(pool._conn.execute.mock.calls[1]![0]).toContain('SET image_filename = ?');
    expect(pool._conn.execute.mock.calls[1]![1]).toEqual(['new.png', 7]);
  });

  it('clears the sound', async () => {
    pool._conn.execute.mockResolvedValueOnce([[{ filename: null }], []]).mockResolvedValueOnce([{}, []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'sound', null)).toEqual({ previous: null });
    expect(pool._conn.execute.mock.calls[1]![0]).toContain('SET sound_filename = ?');
  });

  it('returns null when the command has no alert or is not the streamer\'s', async () => {
    pool._conn.execute.mockResolvedValueOnce([[], []]);
    expect(await setAdvancedCommandAlertAsset(3, 7, 'image', 'x.png')).toBeNull();
  });
});
