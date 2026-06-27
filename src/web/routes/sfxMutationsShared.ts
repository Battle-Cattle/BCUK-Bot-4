import { createLogger } from '../../shared/logger';
import fs from 'fs';
import { SFX_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';

const log = createLogger('Web');

/**
 * Remove a list of relative sound-file paths from disk, resolving each safely
 * within SFX_FOLDER. Logs and swallows individual failures so a missing file
 * never blocks the surrounding DB operation.
 */
export async function removeSfxFiles(files: string[]): Promise<void> {
  for (const file of files) {
    const fullPath = safeResolve(SFX_FOLDER, file);
    if (!fullPath) continue;
    try {
      await fs.promises.rm(fullPath, { force: true });
    } catch (err) {
      log.error(`Failed to remove SFX file ${file}:`, err);
    }
  }
}

/**
 * Parse a weight form field into a positive integer, or null when the value is
 * missing/non-numeric/non-positive. Requires the whole string to be digits (an
 * exact integer) so partially-numeric input like `1abc` or `1.5` is rejected
 * rather than truncated to 1 by `parseInt`. Returning null (rather than
 * defaulting to 1) lets callers reject a malformed update instead of silently
 * overwriting the stored weight.
 * @param value Raw `weight` form field.
 * @returns A positive integer weight, or null when invalid.
 */
export function parseWeight(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
