import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
// Use a mutable variable so individual tests can temporarily clear the secret.
let mockSecret: string | undefined = 'a'.repeat(64);
vi.mock('../shared/config', () => ({
  get EVENTSUB_TOKEN_SECRET() { return mockSecret; },
}));
vi.mock('../shared/crypto', () => ({
  encryptToken: vi.fn((value: string) => `enc:${value}`),
  decryptToken: vi.fn((value: string) => value.replace('enc:', '')),
}));

import { getPool } from './pool';
import { encryptToken, decryptToken } from '../shared/crypto';
import {
  getAllEventSubStreamers,
  getStreamerByDiscordId,
  getStreamerById,
  saveStreamerToken,
  clearStreamerToken,
  initEventConfig,
  saveEventConfig,
} from './eventSub';

function makePool(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue([[...rows], []]) };
}

function makeRow(overrides: object = {}): Record<string, unknown> {
  return {
    id: 1,
    discord_id: '100',
    twitch_name: 'alice',
    twitch_user_id: 'uid1',
    eventsub_access_token: null,
    eventsub_refresh_token: null,
    eventsub_token_expiry: null,
    follow_enabled: null,  // null → config is null
    follow_message: null,
    sub_enabled: null,
    sub_message: null,
    resub_message: null,
    giftsub_message: null,
    raid_enabled: null,
    raid_message: null,
    ...overrides,
  };
}

function makeRowWithConfig(overrides: object = {}): Record<string, unknown> {
  return makeRow({
    follow_enabled: 1,
    follow_message: 'Thanks {display_name}!',
    sub_enabled: 0,
    sub_message: 'Sub msg',
    resub_message: 'Resub msg',
    giftsub_message: 'Gift msg',
    raid_enabled: 1,
    raid_message: 'Raid msg',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(encryptToken).mockImplementation((v: string) => `enc:${v}`);
  vi.mocked(decryptToken).mockImplementation((v: string) => v.replace('enc:', ''));
});

// ─── getAllEventSubStreamers ───────────────────────────────────────────────────

describe('getAllEventSubStreamers', () => {
  it('returns empty array when no rows', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getAllEventSubStreamers()).toEqual([]);
  });

  it('maps a row with no config (follow_enabled=null) to config=null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.config).toBeNull();
  });

  it('maps a row with config correctly, including BIT flags', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRowWithConfig()]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.config).not.toBeNull();
    expect(s.config!.follow_enabled).toBe(true);
    expect(s.config!.sub_enabled).toBe(false);
    expect(s.config!.raid_enabled).toBe(true);
  });

  it('maps BIT(1) config flags as Buffer correctly', async () => {
    const row = makeRowWithConfig({ follow_enabled: Buffer.from([1]), sub_enabled: Buffer.from([0]), raid_enabled: Buffer.from([0]) });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.config!.follow_enabled).toBe(true);
    expect(s.config!.sub_enabled).toBe(false);
    expect(s.config!.raid_enabled).toBe(false);
  });

  it('decrypts access and refresh tokens via maybeDecrypt', async () => {
    const row = makeRow({ eventsub_access_token: 'enc:accessabc', eventsub_refresh_token: 'enc:refreshxyz' });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.eventsub_access_token).toBe('accessabc');
    expect(s.eventsub_refresh_token).toBe('refreshxyz');
  });

  it('returns null tokens when decryptToken throws', async () => {
    vi.mocked(decryptToken).mockImplementation(() => { throw new Error('Bad decrypt'); });
    const row = makeRow({ eventsub_access_token: 'corrupted', eventsub_refresh_token: 'bad' });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.eventsub_access_token).toBeNull();
    expect(s.eventsub_refresh_token).toBeNull();
  });

  it('coerces discord_id to string', async () => {
    const row = makeRow({ discord_id: 12345n });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.discord_id).toBe('12345');
  });

  it('converts eventsub_token_expiry to Number', async () => {
    const row = makeRow({ eventsub_token_expiry: '9007199254740993' });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(typeof s.eventsub_token_expiry).toBe('number');
  });

  it('maps eventsub_token_expiry=null to null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    const [s] = await getAllEventSubStreamers();
    expect(s.eventsub_token_expiry).toBeNull();
  });
});

// ─── getStreamerByDiscordId ───────────────────────────────────────────────────

describe('getStreamerByDiscordId', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getStreamerByDiscordId('999')).toBeNull();
  });

  it('maps the found row', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    const result = await getStreamerByDiscordId('100');
    expect(result!.discord_id).toBe('100');
  });

  it('queries with the given discordId', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getStreamerByDiscordId('abc');
    expect(pool.execute.mock.calls[0][1]).toContain('abc');
  });
});

// ─── getStreamerById ──────────────────────────────────────────────────────────

describe('getStreamerById', () => {
  it('returns null when no rows found', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getStreamerById(999)).toBeNull();
  });

  it('queries with the given id', async () => {
    const pool = makePool([]);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await getStreamerById(42);
    expect(pool.execute.mock.calls[0][1]).toContain(42);
  });
});

// ─── saveStreamerToken ────────────────────────────────────────────────────────

describe('saveStreamerToken', () => {
  it('throws when EVENTSUB_TOKEN_SECRET is not configured', async () => {
    const prev = mockSecret;
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(saveStreamerToken(1, 'uid', 'access', 'refresh', null)).rejects.toThrow('EVENTSUB_TOKEN_SECRET');
    mockSecret = prev;
  });

  it('encrypts tokens before saving', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveStreamerToken(1, 'uid', 'myaccess', 'myrefresh', 1234567890);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('enc:myaccess');
    expect(params).toContain('enc:myrefresh');
    expect(params).not.toContain('myaccess');
    expect(params).not.toContain('myrefresh');
  });

  it('includes twitchUserId, expiryMs, and streamerId in the query params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveStreamerToken(7, 'u123', 'a', 'r', 9999);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('u123');
    expect(params).toContain(9999);
    expect(params).toContain(7);
  });
});

// ─── clearStreamerToken ───────────────────────────────────────────────────────

describe('clearStreamerToken', () => {
  it('executes UPDATE NULLing token fields for the given streamerId', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearStreamerToken(5);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql.toLowerCase()).toContain('update');
    expect(params).toContain(5);
  });
});

// ─── initEventConfig ──────────────────────────────────────────────────────────

describe('initEventConfig', () => {
  it('uses INSERT IGNORE in the SQL', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await initEventConfig(3);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql.toUpperCase()).toContain('INSERT IGNORE');
  });

  it('includes the streamerId in the params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await initEventConfig(42);
    expect(pool.execute.mock.calls[0][1]).toContain(42);
  });
});

// ─── saveEventConfig ──────────────────────────────────────────────────────────

describe('saveEventConfig', () => {
  const eventConfig: import('./eventSub').EventSubConfig = {
    follow_enabled: true,
    follow_message: 'follow!',
    sub_enabled: false,
    sub_message: 'sub!',
    resub_message: 'resub!',
    giftsub_message: 'gift!',
    raid_enabled: true,
    raid_message: 'raid!',
  };

  it('uses ON DUPLICATE KEY UPDATE in the SQL', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveEventConfig(1, eventConfig);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql.toUpperCase()).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('converts boolean flags to 1/0 in params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveEventConfig(1, eventConfig);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    // follow_enabled=true → 1, sub_enabled=false → 0
    expect(params).toContain(1);
    expect(params).toContain(0);
  });

  it('includes all message strings in params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveEventConfig(1, eventConfig);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('follow!');
    expect(params).toContain('sub!');
    expect(params).toContain('resub!');
    expect(params).toContain('gift!');
    expect(params).toContain('raid!');
  });
});
