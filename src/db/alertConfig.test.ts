import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` is reimplemented here (rather than via `importOriginal`) so this
// test doesn't pull in pool.ts's real `../shared/config` import chain, which throws
// in a test environment with no DISCORD_TOKEN etc. set. The logic mirrors pool.ts's
// real implementation exactly, driven by the same mocked `getPool()`.
vi.mock('./pool', () => {
  const getPool = vi.fn();
  return {
    getPool,
    withTransaction: async (work: (conn: unknown) => Promise<unknown>) => {
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
  };
});
vi.mock('mysql2/promise', () => ({ default: {} }));

import { getPool } from './pool';
import {
  ALERT_EVENT_TYPES,
  getAlertConfigsForStreamer,
  getAlertConfig,
  initAlertConfigs,
  saveAlertConfig,
  setAlertImage,
  setAlertSound,
} from './alertConfig';
import { makeMockPool, makeMockConnection } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows. */
function makePool(rows: unknown[] = []) {
  return makeMockPool({ rows });
}

/** Builds a fake `alert_config` table row, pass `overrides` to customize. */
function makeRow(overrides: object = {}): Record<string, unknown> {
  return {
    id: 1,
    streamer_id: 1,
    event_type: 'follow',
    enabled: 0,
    message_template: 'Thanks {display_name}!',
    image_filename: null,
    sound_filename: null,
    duration_ms: 6000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── ALERT_EVENT_TYPES ────────────────────────────────────────────────────────

describe('ALERT_EVENT_TYPES', () => {
  it('lists all five event types', () => {
    expect(ALERT_EVENT_TYPES).toEqual(['follow', 'sub', 'resub', 'giftsub', 'raid']);
  });
});

// ─── getAlertConfigsForStreamer ───────────────────────────────────────────────

describe('getAlertConfigsForStreamer', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAlertConfigsForStreamer(1)).toEqual([]);
  });

  it('maps rows correctly, including BIT flags', async () => {
    const rows = [makeRow({ enabled: 1 }), makeRow({ id: 2, event_type: 'raid', enabled: 0 })];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const configs = await getAlertConfigsForStreamer(1);
    expect(configs).toHaveLength(2);
    expect(configs[0].enabled).toBe(true);
    expect(configs[1].enabled).toBe(false);
    expect(configs[1].event_type).toBe('raid');
  });

  it('maps BIT(1) enabled flag as Buffer correctly', async () => {
    const rows = [makeRow({ enabled: Buffer.from([1]) })];
    vi.mocked(getPool).mockReturnValue(makePool(rows) as any);
    const [config] = await getAlertConfigsForStreamer(1);
    expect(config.enabled).toBe(true);
  });

  it('maps null image/sound filenames', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    const [config] = await getAlertConfigsForStreamer(1);
    expect(config.image_filename).toBeNull();
    expect(config.sound_filename).toBeNull();
  });

  it('queries with the given streamerId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getAlertConfigsForStreamer(42);
    expect(pool.execute.mock.calls[0][1]).toContain(42);
  });
});

// ─── getAlertConfig ────────────────────────────────────────────────────────────

describe('getAlertConfig', () => {
  it('returns null when no matching row', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAlertConfig(1, 'follow')).toBeNull();
  });

  it('maps the found row', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow({ event_type: 'sub', enabled: 1 })]) as any);
    const config = await getAlertConfig(1, 'sub');
    expect(config).not.toBeNull();
    expect(config!.event_type).toBe('sub');
    expect(config!.enabled).toBe(true);
  });

  it('queries with the given streamerId and eventType', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getAlertConfig(7, 'raid');
    expect(pool.execute.mock.calls[0][1]).toEqual([7, 'raid']);
  });
});

// ─── initAlertConfigs ──────────────────────────────────────────────────────────

describe('initAlertConfigs', () => {
  it('uses INSERT IGNORE in the SQL', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await initAlertConfigs(3);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql.toUpperCase()).toContain('INSERT IGNORE');
  });

  it('inserts one row per event type with the streamerId and a default template', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await initAlertConfigs(5);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    for (const eventType of ALERT_EVENT_TYPES) {
      expect(params).toContain(eventType);
    }
    expect(params.filter((p) => p === 5)).toHaveLength(ALERT_EVENT_TYPES.length);
  });
});

// ─── saveAlertConfig ───────────────────────────────────────────────────────────

describe('saveAlertConfig', () => {
  it('uses ON DUPLICATE KEY UPDATE in the SQL', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveAlertConfig(1, 'follow', { enabled: true, message_template: 'hi {display_name}', duration_ms: 5000 });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql.toUpperCase()).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('does not touch image_filename/sound_filename columns', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveAlertConfig(1, 'follow', { enabled: true, message_template: 'hi', duration_ms: 5000 });
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql).not.toContain('image_filename=');
    expect(sql).not.toContain('sound_filename=');
  });

  it('converts enabled boolean to 1/0 in params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveAlertConfig(1, 'sub', { enabled: false, message_template: 'msg', duration_ms: 4000 });
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toEqual([1, 'sub', 0, 'msg', 4000]);
  });
});

// ─── setAlertImage / setAlertSound ─────────────────────────────────────────────

describe('setAlertImage', () => {
  it('returns null and does not update when no matching row exists', async () => {
    const conn = makeMockConnection({ execute: vi.fn().mockResolvedValue([[], []]) });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    const result = await setAlertImage(1, 'follow', 'new.png');
    expect(result).toBeNull();
    expect(conn.execute).toHaveBeenCalledTimes(1);
  });

  it('returns the previous filename and updates to the new one', async () => {
    const conn = makeMockConnection({
      execute: vi.fn()
        .mockResolvedValueOnce([[{ image_filename: 'old.png' }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]),
    });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    const result = await setAlertImage(1, 'follow', 'new.png');
    expect(result).toBe('old.png');
    const [updateSql, updateParams] = conn.execute.mock.calls[1];
    expect(updateSql.toUpperCase()).toContain('UPDATE');
    expect(updateParams).toEqual(['new.png', 1, 'follow']);
  });

  it('commits the transaction on success', async () => {
    const conn = makeMockConnection({
      execute: vi.fn().mockResolvedValue([[{ image_filename: null }], []]),
    });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    await setAlertImage(1, 'follow', null);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
  });
});

describe('setAlertSound', () => {
  it('returns null when no matching row exists', async () => {
    const conn = makeMockConnection({ execute: vi.fn().mockResolvedValue([[], []]) });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    expect(await setAlertSound(1, 'raid', 'air.mp3')).toBeNull();
  });

  it('returns the previous filename and updates to the new one', async () => {
    const conn = makeMockConnection({
      execute: vi.fn()
        .mockResolvedValueOnce([[{ sound_filename: 'old.mp3' }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]),
    });
    vi.mocked(getPool).mockReturnValue(makeMockPool({ connection: conn }) as any);
    const result = await setAlertSound(1, 'raid', 'air.mp3');
    expect(result).toBe('old.mp3');
    const [updateSql, updateParams] = conn.execute.mock.calls[1];
    expect(updateSql.toUpperCase()).toContain('UPDATE');
    expect(updateParams).toEqual(['air.mp3', 1, 'raid']);
  });
});
