import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { removeStreamer } from './streamMonitor';
import { foreignKeys, insertRow } from '../test-utils/realDbRows';

// What deleting a user or a streamer does to the rows that reference it, against a real MySQL
// (npm run test:db). DATABASE-SCHEMA.md is the spec: each foreign key's ON DELETE rule is read
// from it, checked against the schema MySQL actually has, then exercised by deleting a parent.

/** Parents whose deletion these tests cover. */
const PARENTS = new Set(['user', 'streamer']);

interface DocumentedForeignKey {
  table: string;
  column: string;
  referencedTable: string;
  /** As MySQL reports it; `NO ACTION` when the doc gives no rule. */
  deleteRule: string;
}

/**
 * Reads every foreign key DATABASE-SCHEMA.md documents, from each table section's column rows
 * ("FK to `parent.column` ON DELETE …") and, where a row names no rule, its "Expected
 * constraints" bullets ("FOREIGN KEY (column) REFERENCES parent(column) ON DELETE …").
 */
function documentedForeignKeys(): DocumentedForeignKey[] {
  const doc = readFileSync(path.resolve(__dirname, '../../DATABASE-SCHEMA.md'), 'utf8');
  const keys: DocumentedForeignKey[] = [];
  for (const section of doc.split(/^## /m).slice(1)) {
    const table = /^`(\w+)`/.exec(section)?.[1];
    if (!table) continue;
    for (const [, column, referencedTable, rule] of section.matchAll(/^\| `(\w+)` \|[^\n]*?FK to `(\w+)\.\w+`(?:[^\n]*?ON DELETE (CASCADE|SET NULL))?/gm)) {
      const bullet = new RegExp(`FOREIGN KEY \\(${column}\\) REFERENCES \`?${referencedTable}\`?\\(\\w+\\) ON DELETE (CASCADE|SET NULL)`).exec(section);
      keys.push({ table, column: column!, referencedTable: referencedTable!, deleteRule: rule ?? bullet?.[1] ?? 'NO ACTION' });
    }
  }
  return keys;
}

const DOCUMENTED = documentedForeignKeys().filter((k) => PARENTS.has(k.referencedTable));
const STREAMER_CHILDREN = DOCUMENTED.filter((k) => k.referencedTable === 'streamer');

/** A parent row and how the app (or, for a user, an admin) deletes it. */
interface Parent {
  key: string;
  delete(): Promise<void>;
}

/** Inserts a user, deleted directly: nothing in the app deletes a referenced user. */
async function newUser(): Promise<Parent> {
  const user = await insertRow('user');
  const key = String(user.discord_id);
  return { key, delete: async () => { await getPool().execute('DELETE FROM `user` WHERE discord_id = ?', [key]); } };
}

/** Inserts a streamer, deleted the way the app does it: `removeStreamer`, scoped to its guild. */
async function newStreamer(): Promise<Parent> {
  const streamer = await insertRow('streamer');
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>('SELECT guild_id FROM stream_group WHERE id = ?', [Number(streamer.group_id)]);
  const id = Number(streamer.id);
  return {
    key: String(id),
    delete: async () => { expect(await removeStreamer(id, String(rows[0]!.guild_id))).toBe(true); },
  };
}

/** Every value of `column` in `table`, as strings (null kept), sorted. */
async function columnValues(table: string, column: string): Promise<(string | null)[]> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(`SELECT \`${column}\` AS v FROM \`${table}\``);
  return rows.map((r) => (r.v === null ? null : String(r.v))).sort();
}

describe('deleting a user or streamer (real MySQL)', () => {
  it('has exactly the foreign keys to user and streamer that DATABASE-SCHEMA.md documents, with the same delete rules', async () => {
    const actual = (await foreignKeys())
      .filter((k) => PARENTS.has(k.referencedTable))
      .map(({ table, column, referencedTable, deleteRule }) => ({ table, column, referencedTable, deleteRule }));
    const byName = (a: DocumentedForeignKey, b: DocumentedForeignKey): number => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`);

    expect(DOCUMENTED.length).toBeGreaterThan(20);
    expect(actual.sort(byName)).toEqual([...DOCUMENTED].sort(byName));
  });

  it.each(DOCUMENTED)('$table ($column): deleting its $referencedTable applies ON DELETE $deleteRule to that row only', async ({ table, column, referencedTable, deleteRule }) => {
    const newParent = referencedTable === 'user' ? newUser : newStreamer;
    const doomed = await newParent();
    const kept = await newParent();
    await insertRow(table, { [column]: doomed.key });
    await insertRow(table, { [column]: kept.key });

    await doomed.delete();

    expect(await columnValues(table, column)).toEqual(deleteRule === 'SET NULL' ? [kept.key, null].sort() : [kept.key]);
  });

  it("removes a deleted user's streamer row, and with it every row that cascades from the streamer", async () => {
    const user = await newUser();
    const streamer = await insertRow('streamer', { discord_id: user.key });
    for (const { table, column } of STREAMER_CHILDREN) await insertRow(table, { [column]: streamer.id });

    await user.delete();

    expect(await columnValues('streamer', 'discord_id')).toEqual([]);
    const remaining = await Promise.all(STREAMER_CHILDREN.map(async ({ table, column, deleteRule }) => ({
      key: `${table}.${column}`, deleteRule, values: await columnValues(table, column),
    })));
    expect(remaining).toEqual(STREAMER_CHILDREN.map(({ table, column, deleteRule }) => ({
      key: `${table}.${column}`, deleteRule, values: deleteRule === 'SET NULL' ? [null] : [],
    })));
  });
});
