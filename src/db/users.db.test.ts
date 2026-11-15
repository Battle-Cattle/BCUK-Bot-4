import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { deleteUnlinkedUserRecord, upsertUserRecord, USER_REFERENCING_COLUMNS } from './users';
import { insertRow } from '../test-utils/realDbRows';

// deleteUnlinkedUserRecord's guard against a real MySQL (npm run test:db): it must refuse while
// anything references the user, since deleting the row would cascade away (or null out) that data.

/** Whether the user row still exists. */
async function userExists(discordId: string): Promise<boolean> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>('SELECT 1 FROM `user` WHERE discord_id = ?', [discordId]);
  return rows.length > 0;
}

describe('deleteUnlinkedUserRecord (real MySQL)', () => {
  it('deletes a user nothing references', async () => {
    const discordId = String((await insertRow('user')).discord_id);

    expect(await deleteUnlinkedUserRecord(discordId)).toBe(true);
    expect(await userExists(discordId)).toBe(false);
  });

  it.each(USER_REFERENCING_COLUMNS)('keeps a user while %s.%s references them, and only that user', async (table, column) => {
    const discordId = String((await insertRow('user')).discord_id);
    const otherId = String((await insertRow('user')).discord_id);
    await insertRow(table, { [column]: discordId });

    expect(await deleteUnlinkedUserRecord(discordId)).toBe(false);
    expect(await userExists(discordId)).toBe(true);
    // Another user isn't held by this user's reference: the guard filters on the user it's deleting.
    expect(await deleteUnlinkedUserRecord(otherId)).toBe(true);
    const [references] = await getPool().query<mysql.RowDataPacket[]>(`SELECT 1 FROM \`${table}\` WHERE \`${column}\` = ?`, [discordId]);
    expect(references).toHaveLength(1);
    // The guard covers this one column: with its row gone, nothing else holds the user.
    await getPool().query(`DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [discordId]);
    expect(await deleteUnlinkedUserRecord(discordId)).toBe(true);
  });
});

describe('upsertUserRecord (real MySQL)', () => {
  async function storedUser(discordId: string): Promise<mysql.RowDataPacket | undefined> {
    const [rows] = await getPool().execute<mysql.RowDataPacket[]>('SELECT discord_name, twitch_name FROM `user` WHERE discord_id = ?', [discordId]);
    return rows[0];
  }

  it('inserts on the first call, then updates the name, keeping the Twitch name unless one is given', async () => {
    const discordId = '1234567890123456789';
    await upsertUserRecord(discordId, 'First', 'firstchannel');
    expect(await storedUser(discordId)).toEqual({ discord_name: 'First', twitch_name: 'firstchannel' });

    await upsertUserRecord(discordId, 'Renamed');
    expect(await storedUser(discordId)).toEqual({ discord_name: 'Renamed', twitch_name: 'firstchannel' });

    await upsertUserRecord(discordId, 'Renamed', 'secondchannel');
    expect(await storedUser(discordId)).toEqual({ discord_name: 'Renamed', twitch_name: 'secondchannel' });

    await upsertUserRecord(discordId, '  ', null);
    expect(await storedUser(discordId)).toEqual({ discord_name: null, twitch_name: null });
  });
});

