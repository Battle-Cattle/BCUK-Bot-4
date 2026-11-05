import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger';
import { OVERLAY_TRANSCODE_TIMEOUT_MINUTES } from '../../shared/config';

// File helpers shared by the overlay upload storage and the MOV conversion: reading a file's
// first bytes to check its type, and sweeping temporary files an earlier upload failed to remove.

const log = createLogger('OverlayFiles');

/**
 * Most conversions queued or running at once, each of which can run for
 * `OVERLAY_TRANSCODE_TIMEOUT_MINUTES` (mirrors `MAX_PENDING_WEBM_TRANSCODES`, which a test keeps equal).
 */
const MAX_QUEUED_CONVERSIONS = 3;

/**
 * A temporary upload or conversion file older than this is a leftover whose removal failed, never
 * one an upload is still using: a finished upload can wait behind every other queued conversion
 * and then run its own, each up to the conversion timeout, so this allows all of them plus an hour.
 */
export const STALE_TEMP_FILE_MS = 60 * 60_000 + MAX_QUEUED_CONVERSIONS * OVERLAY_TRANSCODE_TIMEOUT_MINUTES * 60_000;

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
  // One at a time, so a large backlog can't crowd other filesystem work out of the threadpool.
  for (const name of names.filter(isTempFile)) await removeIfStale(path.join(dir, name), now);
}
