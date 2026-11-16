import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { getTokenStatus, issueToken, revokeToken } from './companionTokens';
import { insertRow } from '../test-utils/realDbRows';

// issueToken's upsert against a real MySQL (npm run test:db): one row per user, and re-issuing
// after a revocation replaces the hash and clears revoked_at.

describe('issueToken (real MySQL)', () => {
  it('replaces a revoked token on the same row, making it active again', async () => {
    const discordId = String((await insertRow('user')).discord_id);
    await issueToken(discordId);
    await revokeToken(discordId);
    expect(await getTokenStatus(discordId)).toMatchObject({ hasToken: false });
    const [[before]] = await getPool().execute<mysql.RowDataPacket[]>('SELECT key_hash FROM companion_app_tokens WHERE discord_id = ?', [discordId]);

    await issueToken(discordId);

    expect(await getTokenStatus(discordId)).toMatchObject({ hasToken: true });
    const [rows] = await getPool().execute<mysql.RowDataPacket[]>('SELECT key_hash FROM companion_app_tokens WHERE discord_id = ?', [discordId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).not.toBe(before!.key_hash);
  });
});
