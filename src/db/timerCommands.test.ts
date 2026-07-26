import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  getTimerCommandsForStreamer,
  addTimerCommand,
  updateTimerCommand,
  removeTimerCommand,
  setTimerCommandEnabled,
  getAllEnabledTimerCommandsWithChannel,
  TimerCommandNotFoundError,
  type TimerCommandInput,
} from './timerCommands';
import { makeMockPool } from '../test-utils/mockMysqlPool';

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleRow = {
  id: 1,
  streamer_id: 7,
  name: 'Discord plug',
  message: 'Join our Discord!',
  interval_seconds: 600,
  min_messages: 5,
  require_live: 1,
  enabled: 1,
};

const sampleInput: TimerCommandInput = {
  name: 'Discord plug',
  message: 'Join our Discord!',
  intervalSeconds: 600,
  minMessages: 5,
  requireLive: true,
  enabled: true,
};

describe('getTimerCommandsForStreamer', () => {
  it('maps rows, converting BIT columns to booleans', async () => {
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [sampleRow] }) as any);
    const rows = await getTimerCommandsForStreamer(7);
    expect(rows).toEqual([{
      id: 1,
      streamer_id: 7,
      name: 'Discord plug',
      message: 'Join our Discord!',
      interval_seconds: 600,
      min_messages: 5,
      require_live: true,
      enabled: true,
    }]);
  });

  it('queries scoped to the streamer id', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getTimerCommandsForStreamer(7);
    expect(pool.execute.mock.calls[0][1]).toEqual([7]);
  });
});

describe('addTimerCommand', () => {
  it('inserts and returns the new insertId', async () => {
    const pool = makeMockPool({ executeResult: [{ insertId: 42 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    const id = await addTimerCommand(7, sampleInput);
    expect(id).toBe(42);
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 'Discord plug', 'Join our Discord!', 600, 5, 1, 1]);
  });
});

describe('updateTimerCommand', () => {
  it('updates when a row matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateTimerCommand(1, 7, sampleInput)).resolves.toBeUndefined();
    expect(pool.execute.mock.calls[0][1]).toEqual(['Discord plug', 'Join our Discord!', 600, 5, 1, 1, 1, 7]);
  });

  it('throws TimerCommandNotFoundError when no row matched (wrong id or wrong streamer)', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(updateTimerCommand(1, 999, sampleInput)).rejects.toThrow(TimerCommandNotFoundError);
  });
});

describe('removeTimerCommand', () => {
  it('deletes scoped to id and streamer id', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await removeTimerCommand(1, 7);
    expect(pool.execute.mock.calls[0][1]).toEqual([1, 7]);
  });

  it('no-ops without throwing when nothing matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(removeTimerCommand(1, 999)).resolves.toBeUndefined();
  });
});

describe('setTimerCommandEnabled', () => {
  it('updates the enabled flag when a row matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 1 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await setTimerCommandEnabled(1, 7, false);
    expect(pool.execute.mock.calls[0][1]).toEqual([0, 1, 7]);
  });

  it('throws TimerCommandNotFoundError when no row matched', async () => {
    const pool = makeMockPool({ executeResult: [{ affectedRows: 0 }] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await expect(setTimerCommandEnabled(1, 999, true)).rejects.toThrow(TimerCommandNotFoundError);
  });
});

describe('getAllEnabledTimerCommandsWithChannel', () => {
  it('maps joined rows to scheduler shape', async () => {
    const joinedRow = {
      id: 1,
      channel: 'somestreamer',
      message: 'Join our Discord!',
      interval_seconds: 600,
      min_messages: 5,
      require_live: 1,
    };
    vi.mocked(getPool).mockReturnValue(makeMockPool({ rows: [joinedRow] }) as any);
    const rows = await getAllEnabledTimerCommandsWithChannel();
    expect(rows).toEqual([{
      id: 1,
      channel: 'somestreamer',
      message: 'Join our Discord!',
      interval_seconds: 600,
      min_messages: 5,
      require_live: true,
    }]);
  });

  it('queries with no parameters (filtering happens in SQL)', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getAllEnabledTimerCommandsWithChannel();
    expect(pool.execute.mock.calls[0][1]).toBeUndefined();
  });
});
