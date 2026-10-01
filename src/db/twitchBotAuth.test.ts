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
  getBotChatToken, saveBotChatTokenIfLatestAttempt, restoreBotChatTokenIfOwnedByConnection,
  clearBotChatToken, saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy,
} from './twitchBotAuth';
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
    connection_id: 1,
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
      connectionId: 1,
    });
  });

  it('coerces connection_id to a number', async () => {
    vi.mocked(getPool).mockReturnValue(makePool([makeRow({ connection_id: '7' })]) as any);
    const token = await getBotChatToken();
    expect(token!.connectionId).toBe(7);
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

// ─── saveBotChatTokenIfLatestAttempt ──────────────────────────────────────────

describe('saveBotChatTokenIfLatestAttempt', () => {
  /** Builds a pool whose upsert call is a no-op and whose follow-up SELECT reports `wonAttempt`/`wonConnectionId` as the row's `attempt_started_at`/`connection_id`. */
  function makeAttemptPool(wonAttempt: number, wonConnectionId = 2) {
    return makeMockPool({ executeResult: [[{ attempt_started_at: wonAttempt, connection_id: wonConnectionId }], []] });
  }

  it('throws when EVENTSUB_TOKEN_SECRET is not configured', async () => {
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(saveBotChatTokenIfLatestAttempt(1000, 'uid', 'access', 'refresh', null)).rejects.toThrow('EVENTSUB_TOKEN_SECRET');
  });

  it('encrypts tokens before saving', async () => {
    const pool = makeAttemptPool(1000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'myaccess', 'myrefresh', 1234567890);
    const params: unknown[] = pool.execute.mock.calls[0]![1];
    expect(params).toContain('enc:myaccess');
    expect(params).toContain('enc:myrefresh');
    expect(params).not.toContain('myaccess');
    expect(params).not.toContain('myrefresh');
  });

  it('includes attemptStartedAt, twitchUserId, and expiryMs in the query params', async () => {
    const pool = makeAttemptPool(1000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfLatestAttempt(1000, 'u123', 'a', 'r', 9999);
    const params: unknown[] = pool.execute.mock.calls[0]![1];
    expect(params).toEqual(['u123', 'enc:a', 'enc:r', 9999, 1000]);
  });

  it('upserts against the singleton row', async () => {
    const pool = makeAttemptPool(1000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null);
    const sql: string = pool.execute.mock.calls[0]![0];
    expect(sql.toUpperCase()).toContain('ON DUPLICATE KEY UPDATE');
  });

  it('bumps connection_id conditionally on winning the attempt-ordering comparison', async () => {
    const pool = makeAttemptPool(1000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null);
    const sql: string = pool.execute.mock.calls[0]![0];
    expect(sql).toContain('twitch_bot_chat_token.connection_id + 1');
  });

  it('qualifies every existing-row column reference in the update clause (bare names are ambiguous with the new_row alias)', async () => {
    const pool = makeAttemptPool(1000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null);
    const sql: string = pool.execute.mock.calls[0]![0];
    const updateClause = sql.slice(sql.toUpperCase().indexOf('ON DUPLICATE KEY UPDATE'));
    for (const column of ['twitch_user_id', 'access_token', 'refresh_token', 'token_expiry', 'connection_id', 'attempt_started_at']) {
      // Only the assignment target itself may appear unqualified (i.e. not preceded by `.`).
      const bare = updateClause.match(new RegExp(`(?<![.\\w])${column}\\b`, 'g')) ?? [];
      expect(bare, column).toHaveLength(1);
    }
  });

  it('returns the row\'s connection_id when this attempt won (its attempt_started_at is now stored)', async () => {
    const pool = makeAttemptPool(1000, 5);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null)).toBe(5);
  });

  it('returns null when a more recently started attempt already holds the row', async () => {
    // The stored attempt_started_at (2000) is newer than this call's own (1000).
    const pool = makeAttemptPool(2000);
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null)).toBeNull();
  });

  it('returns null when the row disappeared between the upsert and the follow-up read', async () => {
    const pool = makeMockPool({ rows: [] });
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveBotChatTokenIfLatestAttempt(1000, 'uid', 'a', 'r', null)).toBeNull();
  });
});

// ─── restoreBotChatTokenIfOwnedByConnection ──────────────────────────────────

describe('restoreBotChatTokenIfOwnedByConnection', () => {
  it('throws when EVENTSUB_TOKEN_SECRET is not configured', async () => {
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(restoreBotChatTokenIfOwnedByConnection(1, 'uid', 'access', 'refresh', null)).rejects.toThrow('EVENTSUB_TOKEN_SECRET');
  });

  it('scopes the UPDATE to the expected connection_id, sets twitch_user_id, and encrypts tokens', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await restoreBotChatTokenIfOwnedByConnection(2, 'old-uid', 'myaccess', 'myrefresh', 1234567890);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE id=1 AND connection_id=?');
    expect(sql).toContain('twitch_user_id=?');
    expect(params).toEqual(['old-uid', 'enc:myaccess', 'enc:myrefresh', 1234567890, 2]);
  });

  it('also bumps connection_id on success', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await restoreBotChatTokenIfOwnedByConnection(2, 'old-uid', 'a', 'r', null);
    const [sql] = pool.execute.mock.calls[0] as [string];
    expect(sql).toContain('connection_id=connection_id + 1');
  });

  it('returns true when the row was restored', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await restoreBotChatTokenIfOwnedByConnection(2, 'old-uid', 'a', 'r', null)).toBe(true);
  });

  it('returns false (declined) when the row has since moved to a newer connection_id', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await restoreBotChatTokenIfOwnedByConnection(2, 'old-uid', 'a', 'r', null)).toBe(false);
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

  it('also bumps connection_id and clears attempt_started_at', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearBotChatToken();
    const [sql] = pool.execute.mock.calls[0] as [string];
    expect(sql).toContain('connection_id=connection_id + 1');
    expect(sql).toContain('attempt_started_at=NULL');
  });
});

// ─── saveBotChatTokenIfOwnedBy ────────────────────────────────────────────────

describe('saveBotChatTokenIfOwnedBy', () => {
  it('throws when EVENTSUB_TOKEN_SECRET is not configured', async () => {
    mockSecret = undefined;
    vi.mocked(getPool).mockReturnValue(makePool() as any);
    await expect(saveBotChatTokenIfOwnedBy(1, 'access', 'refresh', null)).rejects.toThrow('EVENTSUB_TOKEN_SECRET');
  });

  it('scopes the UPDATE to the expected connection_id and encrypts tokens', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await saveBotChatTokenIfOwnedBy(1, 'myaccess', 'myrefresh', 1234567890);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE id=1 AND connection_id=?');
    expect(params).toEqual(['enc:myaccess', 'enc:myrefresh', 1234567890, 1]);
  });

  it('returns true when a row was updated', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveBotChatTokenIfOwnedBy(1, 'a', 'r', null)).toBe(true);
  });

  it('returns false (a superseded write) when the row has since moved to a newer connection_id — including a reconnect to the same account', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await saveBotChatTokenIfOwnedBy(1, 'a', 'r', null)).toBe(false);
  });
});

// ─── clearBotChatTokenIfOwnedBy ───────────────────────────────────────────────

describe('clearBotChatTokenIfOwnedBy', () => {
  it('scopes the UPDATE to the expected connection_id', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearBotChatTokenIfOwnedBy(1);
    const [sql, params] = pool.execute.mock.calls[0] as [string, unknown[]];
    expect(sql.toUpperCase()).toContain('UPDATE');
    expect(sql).toContain('WHERE id=1 AND connection_id=?');
    expect(params).toEqual([1]);
  });

  it('returns false (a superseded clear) when the row has since moved to a newer connection_id', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    expect(await clearBotChatTokenIfOwnedBy(1)).toBe(false);
  });

  it('also bumps connection_id, so a stale onRefresh success from the same provider cannot pass its own CAS check afterwards', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]) };
    vi.mocked(getPool).mockReturnValue(pool as any);
    await clearBotChatTokenIfOwnedBy(1);
    const [sql] = pool.execute.mock.calls[0] as [string];
    expect(sql).toContain('connection_id=connection_id + 1');
  });
});
