import mysql from 'mysql2/promise';
import { getPool } from './pool';
import { fromBit } from './utils';

export interface SfxTrigger {
  id: bigint;
  trigger_command: string;
  category_id: number | null;
  hidden: boolean;
  description: string | null;
}

export interface SfxFile {
  id: number;
  trigger_id: bigint;
  file: string;
  trigger_command: string | null;
  weight: number;
  hidden: boolean;
  category_id: number | null;
}

export interface SfxTriggerRow {
  triggerId: string;
  triggerCommand: string;
  description: string | null;
  hidden: boolean;
  categoryId: number | null;
  categoryName: string | null;
  files: Array<{ id: number; file: string; weight: number; hidden: boolean }>;
}

/**
 * Look up a trigger by its command string (case-insensitive).
 * Hidden triggers ARE included — the hidden flag only affects public listing, not playback.
 */
export async function findTrigger(command: string): Promise<SfxTrigger | null> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_command, category_id, hidden, description
     FROM sfxtrigger
     WHERE LOWER(trigger_command) = ?`,
    [command.toLowerCase()],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: BigInt(row.id),
    trigger_command: row.trigger_command,
    category_id: row.category_id,
    hidden: fromBit(row.hidden),
    description: row.description,
  };
}

/**
 * Return all sound files associated with a trigger (including hidden ones).
 * Hidden files are still played — `hidden` only controls public listing.
 */
export async function findSoundFiles(triggerId: bigint): Promise<SfxFile[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, trigger_id, file, trigger_command, weight, hidden, category_id
     FROM sfx
     WHERE trigger_id = ?`,
    [triggerId.toString()],
  );
  return rows.map((row) => ({
    id: row.id,
    trigger_id: BigInt(row.trigger_id),
    file: row.file,
    trigger_command: row.trigger_command,
    weight: row.weight,
    hidden: fromBit(row.hidden),
    category_id: row.category_id,
  }));
}

export interface PublicSfxTrigger {
  triggerCommand: string;
  categoryName: string | null;
  description: string | null;
}

/** Return all non-hidden SFX triggers for public display, ordered by category then command. */
export async function getPublicSfxTriggers(): Promise<PublicSfxTrigger[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT t.trigger_command AS triggerCommand, c.name AS categoryName, t.description
     FROM sfxtrigger t
     LEFT JOIN sfxcategory c ON t.category_id = c.id
     WHERE t.hidden = 0
     ORDER BY c.name, t.trigger_command`,
  );
  return rows.map((r) => ({
    triggerCommand: r.triggerCommand,
    categoryName: r.categoryName ?? null,
    description: r.description ?? null,
  }));
}

export interface SfxCategory {
  id: number;
  name: string;
}

/** Return all SFX categories ordered by name, for populating management dropdowns. */
export async function getAllCategories(): Promise<SfxCategory[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT id, name FROM sfxcategory ORDER BY name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Create a new SFX category. Returns the new category id. */
export async function createCategory(name: string): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO sfxcategory (name) VALUES (?)`,
    [name],
  );
  return result.insertId;
}

/** Rename an existing SFX category. */
export async function renameCategory(id: number, name: string): Promise<void> {
  await getPool().execute(`UPDATE sfxcategory SET name = ? WHERE id = ?`, [name, id]);
}

/**
 * Delete an SFX category. Triggers/sounds referencing it keep working — the FK
 * is ON DELETE SET NULL, so their category_id becomes NULL (uncategorised).
 */
export async function deleteCategory(id: number): Promise<void> {
  await getPool().execute(`DELETE FROM sfxcategory WHERE id = ?`, [id]);
}

/**
 * Create a new SFX trigger (the command users type). Returns the new trigger id.
 * @param command Full prefixed command string, e.g. `!clap`.
 * @param categoryId Category id, or null for uncategorised.
 * @param description Optional public description, or null.
 * @param hidden Whether the trigger is hidden from the public listing.
 */
export async function createSfxTrigger(
  command: string,
  categoryId: number | null,
  description: string | null,
  hidden: boolean,
): Promise<bigint> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO sfxtrigger (trigger_command, category_id, description, hidden)
     VALUES (?, ?, ?, ?)`,
    [command, categoryId, description, hidden ? 1 : 0],
  );
  return BigInt(result.insertId);
}

/**
 * Update an existing SFX trigger's command, category, description and hidden flag.
 * @param id Trigger id.
 */
export async function updateSfxTrigger(
  id: bigint,
  command: string,
  categoryId: number | null,
  description: string | null,
  hidden: boolean,
): Promise<void> {
  await getPool().execute(
    `UPDATE sfxtrigger
     SET trigger_command = ?, category_id = ?, description = ?, hidden = ?
     WHERE id = ?`,
    [command, categoryId, description, hidden ? 1 : 0, id.toString()],
  );
}

/**
 * Delete an SFX trigger and all of its sound-file rows in a single transaction.
 * Returns the relative paths of the deleted sound files so the caller can remove
 * them from disk.
 * @param id Trigger id.
 */
export async function deleteSfxTrigger(id: bigint): Promise<{ files: string[] }> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT file FROM sfx WHERE trigger_id = ?`,
      [id.toString()],
    );
    const files = rows.map((r) => r.file as string);
    await conn.execute(`DELETE FROM sfx WHERE trigger_id = ?`, [id.toString()]);
    await conn.execute(`DELETE FROM sfxtrigger WHERE id = ?`, [id.toString()]);
    await conn.commit();
    return { files };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Add a sound file to a trigger. Returns the new sfx row id.
 * @param triggerId Owning trigger id.
 * @param file Relative path (within SFX_FOLDER) of the stored audio file.
 * @param weight Weighted-random selection weight (>= 1).
 * @param hidden Whether the file is hidden from the public listing.
 */
export async function addSfxFile(
  triggerId: bigint,
  file: string,
  weight: number,
  hidden: boolean,
): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO sfx (trigger_id, file, weight, hidden) VALUES (?, ?, ?, ?)`,
    [triggerId.toString(), file, weight, hidden ? 1 : 0],
  );
  return result.insertId;
}

/**
 * Update a sound file's weight and hidden flag.
 * @param id sfx row id.
 */
export async function updateSfxFile(id: number, weight: number, hidden: boolean): Promise<void> {
  await getPool().execute(`UPDATE sfx SET weight = ?, hidden = ? WHERE id = ?`, [
    weight,
    hidden ? 1 : 0,
    id,
  ]);
}

/**
 * Delete a sound file row. Returns its relative path for filesystem cleanup, or
 * null if no such row existed.
 * @param id sfx row id.
 */
export async function deleteSfxFile(id: number): Promise<string | null> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT file FROM sfx WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      await conn.rollback();
      return null;
    }
    const file: string = rows[0].file;
    await conn.execute(`DELETE FROM sfx WHERE id = ?`, [id]);
    await conn.commit();
    return file;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** Return all SFX triggers (including hidden) with their associated sound files, for the admin panel. */
export async function getAllSfxTriggers(): Promise<SfxTriggerRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT
       t.id          AS triggerId,
       t.trigger_command AS triggerCommand,
       t.description,
       t.hidden      AS triggerHidden,
       t.category_id AS categoryId,
       c.name        AS categoryName,
       s.id          AS sfxId,
       s.file,
       s.weight,
       s.hidden      AS sfxHidden
     FROM sfxtrigger t
     LEFT JOIN sfxcategory c ON t.category_id = c.id
     LEFT JOIN sfx s ON s.trigger_id = t.id
     ORDER BY c.name, t.trigger_command, s.id`,
  );

  const map = new Map<string, SfxTriggerRow>();
  for (const r of rows) {
    if (!map.has(r.triggerId)) {
      map.set(r.triggerId, {
        triggerId: r.triggerId,
        triggerCommand: r.triggerCommand,
        description: r.description ?? null,
        hidden: fromBit(r.triggerHidden),
        categoryId: r.categoryId ?? null,
        categoryName: r.categoryName ?? null,
        files: [],
      });
    }
    if (r.sfxId !== null) {
      map.get(r.triggerId)!.files.push({
        id: r.sfxId,
        file: r.file,
        weight: r.weight,
        hidden: fromBit(r.sfxHidden),
      });
    }
  }
  return Array.from(map.values());
}
