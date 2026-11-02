import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger';
import { transcodeToWebm } from './overlayVideoTranscode';

const log = createLogger('OverlayMovConversion');

/** Suffix of the temporary copy of an uploaded MOV that ffmpeg reads from. */
const SOURCE_SUFFIX = '.mov.upload';

/** Suffix of a WebM while ffmpeg is still writing it; renamed to `.webm` once it's complete. */
const PARTIAL_SUFFIX = '.webm.part';

/**
 * A temporary conversion file older than this is a leftover whose removal failed, never one an
 * upload is still using: it is well past the longest a conversion can wait for its turn and run.
 */
export const STALE_CONVERSION_FILE_MS = 60 * 60_000;

/**
 * Best-effort removal of a file, logging rather than throwing on failure so the error that
 * triggered the cleanup is the one reported.
 * @param fullPath - Absolute path of the file to remove.
 * @returns Resolves once removal has been attempted; never rejects.
 */
async function removeQuietly(fullPath: string): Promise<void> {
  try {
    await fs.promises.rm(fullPath, { force: true });
  } catch (err) {
    log.error(`Failed to remove overlay conversion file ${fullPath}:`, err);
  }
}

/**
 * True if `name` is one of the conversion's temporary files. Neither suffix matches the overlay
 * source route's `.webm`/`.mp4` filename check, so these files are never served.
 * @param name - A filename in a streamer's overlay folder.
 * @returns True for a temporary MOV copy or a partial WebM.
 */
function isConversionTempFile(name: string): boolean {
  return name.endsWith(SOURCE_SUFFIX) || name.endsWith(PARTIAL_SUFFIX);
}

/**
 * Removes a temporary conversion file if it's older than {@link STALE_CONVERSION_FILE_MS}.
 * @param fullPath - Absolute path of the temporary file.
 * @param now - Current time in epoch milliseconds.
 * @returns Resolves once the file has been checked; never rejects.
 */
async function removeIfStale(fullPath: string, now: number): Promise<void> {
  try {
    const { mtimeMs } = await fs.promises.stat(fullPath);
    if (now - mtimeMs > STALE_CONVERSION_FILE_MS) await fs.promises.rm(fullPath, { force: true });
  } catch (err) {
    log.warn(`Failed to sweep stale overlay conversion file ${fullPath}:`, err);
  }
}

/**
 * Removes temporary conversion files left in `dir` by earlier uploads whose own cleanup failed,
 * so a failed removal can't leave them there for good. Runs before each MOV conversion.
 * @param dir - Absolute path of the streamer's overlay folder.
 * @returns Resolves once the sweep has finished; never rejects.
 */
export async function sweepStaleConversionFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    log.warn(`Failed to list ${dir} for stale overlay conversion files:`, err);
    return;
  }
  const now = Date.now();
  await Promise.all(names.filter(isConversionTempFile).map((name) => removeIfStale(path.join(dir, name), now)));
}

/**
 * Wraps a conversion failure in the error the upload route reports: `transcode_busy` when the
 * conversion queue was full, `transcode_failed` otherwise.
 * @param err - What the conversion or rename threw.
 * @returns An Error carrying the code for the route's redirect.
 */
function conversionError(err: unknown): Error {
  const busy = err instanceof Error && (err as NodeJS.ErrnoException).code === 'transcode_busy';
  return Object.assign(new Error(busy ? 'Video conversion queue full' : 'Video conversion failed'), {
    code: busy ? 'transcode_busy' : 'transcode_failed',
  });
}

/**
 * Converts an uploaded QuickTime video to `<baseName>.webm` in `dir`, via a temporary copy of
 * the upload (ffmpeg needs a seekable file: a MOV's index is often at the end). ffmpeg writes to
 * a `.webm.part` file that's renamed once complete, so a half-written WebM never has a servable
 * name. Both temporary files are removed afterwards; any whose removal fails is picked up by
 * {@link sweepStaleConversionFiles} on a later upload.
 * @param dir - Absolute path of the streamer's overlay folder (already safe-resolved and created).
 * @param baseName - Random base name (no extension) for the stored file.
 * @param buffer - The uploaded MOV's bytes.
 * @returns The stored WebM's filename.
 * @throws With `code: 'transcode_busy'` if too many conversions are pending, or
 *   `code: 'transcode_failed'` if ffmpeg can't convert the file; or the error from writing the
 *   temporary copy (after removing any partial copy).
 */
export async function storeMovAsWebm(dir: string, baseName: string, buffer: Buffer): Promise<string> {
  await sweepStaleConversionFiles(dir);
  const sourcePath = path.join(dir, `${baseName}${SOURCE_SUFFIX}`);
  const partialPath = path.join(dir, `${baseName}${PARTIAL_SUFFIX}`);
  const filename = `${baseName}.webm`;
  try {
    await fs.promises.writeFile(sourcePath, buffer);
  } catch (err) {
    await removeQuietly(sourcePath);
    throw err;
  }
  try {
    await transcodeToWebm(sourcePath, partialPath);
    await fs.promises.rename(partialPath, path.join(dir, filename));
  } catch (err) {
    log.error('Overlay MOV to WebM conversion failed:', err);
    await removeQuietly(partialPath);
    throw conversionError(err);
  } finally {
    await removeQuietly(sourcePath);
  }
  return filename;
}
