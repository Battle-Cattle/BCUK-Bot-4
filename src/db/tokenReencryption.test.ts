import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';

const { mockLog, keys } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  keys: { active: 'a'.repeat(64), previous: '' },
}));

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../shared/config', () => ({
  get EVENTSUB_TOKEN_SECRET() { return keys.active; },
  get EVENTSUB_TOKEN_SECRET_PREVIOUS() { return keys.previous; },
}));

import { getPool } from './pool';
import { decryptToken, encryptToken } from '../shared/crypto';
import { reencryptStoredTokens } from './tokenReencryption';

const OLD_KEY = 'b'.repeat(64);
const NEW_KEY = 'c'.repeat(64);

/** Encrypts the way the code before key rotation did. */
function preRotationEncrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

type Row = { id: number; access: string | null; refresh: string | null };

/**
 * A fake pool over two in-memory tables keyed by name; `query` returns the table the SQL names and
 * `execute` applies the compare-and-swap UPDATE the way MySQL would.
 */
function fakePool(tables: Record<string, Row[]>) {
  const tableOf = (sql: string) => Object.keys(tables).find((t) => new RegExp(`\\b(FROM|UPDATE) ${t}\\b`).test(sql))!;
  return {
    query: vi.fn(async ({ sql }: { sql: string }) => [tables[tableOf(sql)]!.map((r) => ({ ...r }))]),
    execute: vi.fn(async ({ sql }: { sql: string }, [access, refresh, id, oldAccess, oldRefresh]: unknown[]) => {
      const row = tables[tableOf(sql)]!.find((r) => r.id === id && r.access === oldAccess && r.refresh === oldRefresh);
      if (row) Object.assign(row, { access, refresh });
      return [{ affectedRows: row ? 1 : 0 }];
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  keys.active = NEW_KEY;
  keys.previous = OLD_KEY;
});

describe('reencryptStoredTokens', () => {
  it('rewrites tokens under the previous key (old and new code alike) so only the new key is needed', async () => {
    const tables = {
      streamer: [
        { id: 1, access: encryptToken('s1-access', OLD_KEY), refresh: encryptToken('s1-refresh', OLD_KEY) },
        { id: 2, access: preRotationEncrypt('s2-access', OLD_KEY), refresh: preRotationEncrypt('s2-refresh', OLD_KEY) },
      ],
      twitch_bot_chat_token: [
        { id: 1, access: encryptToken('bot-access', OLD_KEY), refresh: encryptToken('bot-refresh', OLD_KEY) },
      ],
    };
    vi.mocked(getPool).mockReturnValue(fakePool(tables) as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 3, unreadable: 0, pending: 0 });

    const plain = Object.values(tables).flat().flatMap((r) => [r.access, r.refresh]).map((v) => decryptToken(v, NEW_KEY));
    expect(plain).toEqual(['s1-access', 's1-refresh', 's2-access', 's2-refresh', 'bot-access', 'bot-refresh']);
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('EVENTSUB_TOKEN_SECRET_PREVIOUS can now be removed'));
  });

  it('leaves tokens the active key reads (including ones from before rotation existed), and null columns, alone', async () => {
    const current = encryptToken('current', NEW_KEY);
    const older = preRotationEncrypt('older', NEW_KEY);
    const tables = {
      streamer: [{ id: 1, access: current, refresh: null }],
      twitch_bot_chat_token: [{ id: 1, access: older, refresh: older }],
    };
    const pool = fakePool(tables);
    vi.mocked(getPool).mockReturnValue(pool as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 0, pending: 0 });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(tables.streamer[0]).toEqual({ id: 1, access: current, refresh: null });
    expect(tables.twitch_bot_chat_token[0]).toEqual({ id: 1, access: older, refresh: older });
  });

  it('changes nothing outside a key rotation, so a deploy can be rolled back', async () => {
    keys.previous = '';
    const tables = { streamer: [{ id: 1, access: encryptToken('a', NEW_KEY), refresh: preRotationEncrypt('r', NEW_KEY) }], twitch_bot_chat_token: [] };
    const pool = fakePool(tables);
    vi.mocked(getPool).mockReturnValue(pool as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 0, pending: 0 });
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('rewrites only the stale half of a pair, keeping the current half byte-for-byte', async () => {
    const current = encryptToken('access', NEW_KEY);
    const tables = { streamer: [{ id: 1, access: current, refresh: encryptToken('refresh', OLD_KEY) }], twitch_bot_chat_token: [] };
    vi.mocked(getPool).mockReturnValue(fakePool(tables) as never);

    await reencryptStoredTokens();

    expect(tables.streamer[0]!.access).toBe(current);
    expect(decryptToken(tables.streamer[0]!.refresh, NEW_KEY)).toBe('refresh');
  });

  it('counts and keeps a token no configured key can decrypt, and warns', async () => {
    const stranded = encryptToken('lost', 'd'.repeat(64));
    const tables = { streamer: [{ id: 1, access: stranded, refresh: stranded }], twitch_bot_chat_token: [] };
    const pool = fakePool(tables);
    vi.mocked(getPool).mockReturnValue(pool as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 2, pending: 0 });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(tables.streamer[0]!.access).toBe(stranded);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('must reconnect'));
  });

  it('does not overwrite a token saved between the read and the write', async () => {
    const tables = { streamer: [{ id: 1, access: encryptToken('old', OLD_KEY), refresh: encryptToken('old', OLD_KEY) }], twitch_bot_chat_token: [] };
    const pool = fakePool(tables);
    const fresh = encryptToken('fresh', NEW_KEY);
    pool.query.mockImplementationOnce(async () => {
      const snapshot = tables.streamer.map((r) => ({ ...r }));
      tables.streamer[0]!.access = fresh; // a reconnect lands right after the SELECT
      return [snapshot];
    });
    vi.mocked(getPool).mockReturnValue(pool as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 0, pending: 1 });
    expect(tables.streamer[0]!.access).toBe(fresh);
    // The missed row may still hold a previous-key token, so the pass mustn't call the key removable.
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('re-checked on the next start'));
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('can now be removed'));
  });

  it('reports a damaged token under the active key as unreadable', async () => {
    const good = encryptToken('ok', NEW_KEY);
    const damaged = `${good.slice(0, -4)}AAAA`;
    const tables = { streamer: [{ id: 1, access: damaged, refresh: good }], twitch_bot_chat_token: [] };
    const pool = fakePool(tables);
    vi.mocked(getPool).mockReturnValue(pool as never);

    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 1, pending: 0 });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('must reconnect'));
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('can now be removed'));
  });

  it('bounds every query with a timeout so a silent database cannot hang startup', async () => {
    const tables = { streamer: [{ id: 1, access: encryptToken('a', OLD_KEY), refresh: null }], twitch_bot_chat_token: [] };
    const pool = fakePool(tables);
    vi.mocked(getPool).mockReturnValue(pool as never);

    await reencryptStoredTokens();

    for (const [options] of [...pool.query.mock.calls, ...pool.execute.mock.calls]) {
      expect(options).toMatchObject({ timeout: 10_000 });
    }
  });

  it('does nothing when no EVENTSUB_TOKEN_SECRET is configured', async () => {
    keys.active = '';
    keys.previous = '';
    await expect(reencryptStoredTokens()).resolves.toEqual({ reencrypted: 0, unreadable: 0, pending: 0 });
    expect(getPool).not.toHaveBeenCalled();
  });

  it('never logs a key or a token', async () => {
    const tables = { streamer: [{ id: 1, access: encryptToken('tok-secret', OLD_KEY), refresh: null }], twitch_bot_chat_token: [] };
    vi.mocked(getPool).mockReturnValue(fakePool(tables) as never);

    await reencryptStoredTokens();

    const logged = JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls]);
    for (const secret of [OLD_KEY, NEW_KEY, 'tok-secret', tables.streamer[0]!.access]) {
      expect(logged).not.toContain(secret);
    }
  });
});
