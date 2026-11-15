import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from '../db/pool';
import { foreignKeys, insertRow } from './realDbRows';

// The generic row seeder itself, against a real MySQL (npm run test:db).

describe('insertRow (real MySQL)', () => {
  it('fills required columns, creating the parent rows their foreign keys need', async () => {
    const row = await insertRow('alert_config');

    // alert_config.streamer_id needs a streamer, which needs a user and a stream group (and its guild).
    const [streamers] = await getPool().execute<mysql.RowDataPacket[]>('SELECT id FROM streamer');
    expect(streamers).toEqual([{ id: row.streamer_id }]);
    expect(row).toEqual(expect.objectContaining({ id: expect.any(Number), event_type: expect.any(String) }));
    const [alerts] = await getPool().execute<mysql.RowDataPacket[]>('SELECT event_type FROM alert_config WHERE id = ?', [Number(row.id)]);
    expect(alerts[0]!.event_type).toBe(row.event_type);
  });

  it('uses the values it is given', async () => {
    const user = await insertRow('user', { discord_id: '1234567890123456789', discord_name: 'Given' });

    expect(user).toEqual({ discord_id: '1234567890123456789', discord_name: 'Given' });
  });

  it('names a table that does not exist', async () => {
    await expect(insertRow('no_such_table')).rejects.toThrow('No table named no_such_table');
  });

  it('names a required column it has no placeholder for', async () => {
    await getPool().query('CREATE TABLE realdb_rows_unsupported (id INT PRIMARY KEY, payload JSON NOT NULL)');
    try {
      await expect(insertRow('realdb_rows_unsupported', { id: 1 })).rejects.toThrow("insertRow can't fill payload: no placeholder for json columns");
    } finally {
      await getPool().query('DROP TABLE realdb_rows_unsupported');
    }
  });
});

describe('foreignKeys (real MySQL)', () => {
  it('lists each foreign key with its delete rule', async () => {
    expect(await foreignKeys()).toContainEqual({
      table: 'streamer', column: 'discord_id', referencedTable: 'user', referencedColumn: 'discord_id', deleteRule: 'CASCADE',
    });
  });
});
