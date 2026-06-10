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

/** Return all SFX triggers (including hidden) with their associated sound files, for the admin panel. */
export async function getAllSfxTriggers(): Promise<SfxTriggerRow[]> {
  const [rows] = await getPool().execute<mysql.RowDataPacket[]>(
    `SELECT
       t.id          AS triggerId,
       t.trigger_command AS triggerCommand,
       t.description,
       t.hidden      AS triggerHidden,
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
