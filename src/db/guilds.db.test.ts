import { describe, it, expect } from 'vitest';
import { getAllGuilds, getGuildById, getGuildsForMember, upsertGuild } from './guilds';
import { setMemberAccessLevel } from './guildMembers';
import { findUser, findUsersByIds, upsertUserRecord, AccessLevel } from './users';

// Discord snowflakes through the real DB functions against a real MySQL (npm run test:db): BIGINT
// columns come back as exact strings (bigNumberStrings), so two ids that differ only past
// Number.MAX_SAFE_INTEGER stay distinct. As JS numbers these pairs would be equal.

const GUILD_A = '1234567890123456789';
const GUILD_B = '1234567890123456788';
const USER_A = '987654321098765432';
const USER_B = '987654321098765433';

describe('snowflake ids above Number.MAX_SAFE_INTEGER (real MySQL)', () => {
  it('keeps the pairs apart: they would collide as numbers', () => {
    expect(Number(GUILD_A)).toBe(Number(GUILD_B));
    expect(Number(USER_A)).toBe(Number(USER_B));
  });

  it('round-trips guild ids exactly', async () => {
    await upsertGuild(GUILD_A, 'Guild A');
    await upsertGuild(GUILD_B, 'Guild B');

    expect((await getAllGuilds()).map((g) => [g.guild_id, g.name]).sort()).toEqual([[GUILD_B, 'Guild B'], [GUILD_A, 'Guild A']].sort());
    expect(await getGuildById(GUILD_A)).toMatchObject({ guild_id: GUILD_A, name: 'Guild A' });
  });

  it('round-trips user ids exactly, and memberships join on them exactly', async () => {
    await upsertGuild(GUILD_A, 'Guild A');
    await upsertGuild(GUILD_B, 'Guild B');
    await upsertUserRecord(USER_A, 'User A');
    await upsertUserRecord(USER_B, 'User B');
    await setMemberAccessLevel(GUILD_A, USER_A, AccessLevel.MOD);

    expect(await findUser(USER_A)).toMatchObject({ discord_id: USER_A, discord_name: 'User A' });
    expect([...(await findUsersByIds([USER_A, USER_B])).keys()].sort()).toEqual([USER_A, USER_B].sort());
    expect((await getGuildsForMember(USER_A)).map((g) => g.guild_id)).toEqual([GUILD_A]);
    expect(await getGuildsForMember(USER_B)).toEqual([]);
  });
});
