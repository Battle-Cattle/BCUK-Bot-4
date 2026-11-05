import fs from 'fs';
import type { Logger } from 'winston';

// File operations the chunked-upload session store (chunkedUploadStore.ts) needs that must never
// throw: each logs its own failure and reports it, so the store can decide what that means.

/**
 * Removes files, logging any that couldn't be removed.
 * @param paths - Absolute paths of the files (already validated).
 * @param log - Logger for failed removals.
 * @returns True once every file is gone (a missing file counts), false if any removal failed; never rejects.
 */
export async function removeFiles(paths: string[], log: Logger): Promise<boolean> {
  const results = await Promise.all(paths.map((p) => fs.promises.rm(p, { force: true }).then(
    () => true,
    (err: unknown) => {
      log.warn(`Failed to remove upload session file ${p}:`, err);
      return false;
    },
  )));
  return results.every(Boolean);
}

/**
 * Removes a file if it was last modified before `cutoff`.
 * @param fullPath - Absolute path of the file.
 * @param cutoff - Epoch milliseconds; a file modified earlier is removed.
 * @param log - Logger for a failed check or removal.
 * @returns Resolves once the file has been checked; never rejects.
 */
export async function removeIfOlderThan(fullPath: string, cutoff: number, log: Logger): Promise<void> {
  try {
    if ((await fs.promises.stat(fullPath)).mtimeMs < cutoff) await fs.promises.rm(fullPath, { force: true });
  } catch (err) {
    log.warn(`Failed to sweep stale upload session file ${fullPath}:`, err);
  }
}

/**
 * Truncates a file to `size` bytes, logging a failure.
 * @param fullPath - Absolute path of the file.
 * @param size - The length to cut the file back to.
 * @param log - Logger for a failure.
 * @returns True once truncated, false if it couldn't be; never rejects.
 */
export async function truncateOrLog(fullPath: string, size: number, log: Logger): Promise<boolean> {
  try {
    await fs.promises.truncate(fullPath, size);
    return true;
  } catch (err) {
    log.error(`Failed to roll back a partly written upload piece in ${fullPath}; dropping the upload:`, err);
    return false;
  }
}
