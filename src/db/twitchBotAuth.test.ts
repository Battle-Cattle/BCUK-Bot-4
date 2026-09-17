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
import { getBotChatToken, saveBotChatToken, clearBotChatToken } from './twitchBotAuth';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool whose `execute`/`query` resolve to the given rows. */
function makePool(rows: unknown[] = []) {
  return makeMockPool({ rows });
}

/** Builds a fake `twitch_bot_chat_token` row, pass `overrides` to customize. */
function makeRow(overrides: object = {}): Record<string, unknown> {
  return {
    twitch_user_id: 'bot-uid',
    access_token: 'enc:accesstok',
    refresh_token: 'enc:refreshtok',
    token_expiry: 1234567890,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSecret = 'a'.repeat(64);
  vi.mocked(encryptToken).mockImplementation((v: string) => `enc:${v}`);
  vi.mocked(decryptToken).mockImplementation((v: string) => v.replace('enc:', ''));
});

// ─── getBotChatToken ────────────────────────────────────────────────────────

describe('getBotChatToken', () => {
  it('returns null when no row exists', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([]) as any);
    expect(await getBotChatToken()).toBeNull();
  });

  it('maps a fully-populated row, decrypting tokens', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    const token = await getBotChatToken();
    expect(token).toEqual({
      twitchUserId: 'bot-uid',
      accessToken: 'accesstok',
      refreshToken: 'refreshtok',
      tokenExpiry: 1234567890,
    });
  });

  it('returns null when the row exists but has no token yet (all-null singleton row)', async () => {
    const row = makeRow({ twitch_user_id: null, access_token: null, refresh_token: null, token_expiry: null });
    vi.mocked(getPool).mockReturnValue(makePool([row]) as any);
    expect(await getBotChatToken()).toBeNull();
  });

  it('returns null when EVENTSUB_TOKEN_SECRET is absent but token values are present', async () => {
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    expect(await getBotChatToken()).toBeNull();
  });

  it('returns null when decryptToken throws', async () => {
    vi.mocked(decryptToken).mockImplementation(() => { throw new Error('Bad decrypt'); });
    vi.mocked(getPool).mockReturnValue(makePool([makeRow()]) as any);
    expect(await getBotChatToken()).toBeNull();
  });

  it('coerces token_expiry to a number', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow({ token_expiry: '1700000000000' })]) as any);
    const token = await getBotChatToken();
    expect(token!.tokenExpiry).toBe(1700000000000);
  });

  it('maps token_expiry=null to null', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow({ token_expiry: null })]) as any);
    const token = await getBotChatToken();
    expect(token!.tokenExpiry).toBeNull();
  });
});

// ─── saveBotChatToken ───────────────────────────────────────────────────────

describe('saveBotChatToken', () => {
  it('throws when EVENTSUB_TOKEN_SECRET is not configured', async () => {
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(saveBotChatToken('uid', 'access', 'refresh', null)).rejects.toThrow('EVENTSUB_TOKEN_SECRET');
  });

  it('encrypts tokens before saving', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatToken('uid', 'myaccess', 'myrefresh', 1234567890);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('enc:myaccess');
    expect(params).toContain('enc:myrefresh');
    expect(params).not.toContain('myaccess');
    expect(params).not.toContain('myrefresh');
  });

  it('includes twitchUserId and expiryMs in the query params', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatToken('u123', 'a', 'r', 9999);
    const params: unknown[] = pool.execute.mock.calls[0][1];
    expect(params).toContain('u123');
    expect(params).toContain(9999);
  });

  it('upserts against the singleton row', async () => {
    const pool = makePool();
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatToken('uid', 'a', 'r', null);
    const sql: string = pool.execute.mock.calls[0][0];
    expect(sql.toUpperCase()).toContain('ON DUPLICATE KEY UPDATE');
  });
});

// ─── clearBotChatToken ──────────────────────────────────────────────────────

describe('clearBotChatToken', () => {
  it('executes an UPDATE nulling all token fields for the singleton row', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearBotChatToken();
    const [sql] = pool.execute.mock.calls[0] as [string];
    expect(sql.toUpperCase()).toContain('UPDATE');
    expect(sql).toContain('WHERE id=1');
  });
});
