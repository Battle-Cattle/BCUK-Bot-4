import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { updateMemberAccessLevel } from './guildMembers';
import { insertRow } from '../test-utils/realDbRows';

// updateMemberAccessLevel against a real MySQL (npm run test:db): it must never create a
// membership, and must report a match even when the level is unchanged (CLIENT_FOUND_ROWS).

/** The user's stored access level in the guild, or null when they have no membership row. */
async function storedLevel(guildId: string, discordId: string): Promise<number | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    'SELECT access_level FROM guild_member WHERE guild_id = ? AND discord_id = ?',
    [guildId, discordId],
  );
  return rows[0] ? Number(rows[0].access_level) : null;
}

describe('updateMemberAccessLevel (real MySQL)', () => {
  it('changes an existing member\'s level, and reports a match when the level is unchanged', async () => {
    const member = await insertRow('guild_member', { access_level: 0 });
    const guildId = String(member.guild_id);
    const discordId = String(member.discord_id);

    expect(await updateMemberAccessLevel(guildId, discordId, 2)).toBe(true);
    expect(await storedLevel(guildId, discordId)).toBe(2);
    expect(await updateMemberAccessLevel(guildId, discordId, 2)).toBe(true);
  });

  it('leaves a non-member out of the guild', async () => {
    const guildId = String((await insertRow('guild')).guild_id);
    const discordId = String((await insertRow('user')).discord_id);

    expect(await updateMemberAccessLevel(guildId, discordId, 2)).toBe(false);
    expect(await storedLevel(guildId, discordId)).toBeNull();
  });
});
