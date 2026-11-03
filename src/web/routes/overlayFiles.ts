import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger';

// File helpers shared by the overlay upload storage and the MOV conversion: reading a file's
// first bytes to check its type, and sweeping temporary files an earlier upload failed to remove.

const log = createLogger('OverlayFiles');

/**
 * A temporary upload or conversion file older than this is a leftover whose removal failed, never
 * one an upload is still using: it's well past the longest an upload can take to arrive, wait for
 * its conversion's turn and convert.
 */
export const STALE_TEMP_FILE_MS = 60 * 60_000;

/**
 * Reads the first bytes of a file, for magic-byte type checks.
 * @param fullPath - Absolute path of the file.
 * @param byteCount - How many bytes to read.
 * @returns Up to `byteCount` bytes from the start of the file (fewer if it's shorter).
 * @throws If the file can't be opened or read.
 */
export async function readFileHeader(fullPath: string, byteCount: number): Promise<Buffer> {
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const header = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(header, 0, byteCount, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Removes a file if it was last modified more than {@link STALE_TEMP_FILE_MS} ago.
 * @param fullPath - Absolute path of the temporary file.
 * @param now - Current time in epoch milliseconds.
 * @returns Resolves once the file has been checked; never rejects.
 */
async function removeIfStale(fullPath: string, now: number): Promise<void> {
  try {
    const { mtimeMs } = await fs.promises.stat(fullPath);
    if (now - mtimeMs > STALE_TEMP_FILE_MS) await fs.promises.rm(fullPath, { force: true });
  } catch (err) {
    log.warn(`Failed to sweep stale overlay temporary file ${fullPath}:`, err);
  }
}

/**
 * Removes stale temporary files from `dir`, so a temporary file whose own removal failed can't
 * stay there for good. Only files `isTempFile` picks out are touched, so stored videos never are.
 * @param dir - Absolute path of the folder to sweep.
 * @param isTempFile - Picks out the temporary files by name.
 * @returns Resolves once the sweep has finished; never rejects (a missing folder is skipped).
 */
export async function sweepStaleTempFiles(dir: string, isTempFile: (name: string) => boolean): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    log.warn(`Failed to list ${dir} for stale overlay temporary files:`, err);
    return;
  }
  const now = Date.now();
  await Promise.all(names.filter(isTempFile).map((name) => removeIfStale(path.join(dir, name), now)));
}
