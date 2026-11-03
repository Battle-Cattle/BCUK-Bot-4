import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger';
import { transcodeToWebm, type ProgressListener } from './overlayVideoTranscode';
import { detectVideoType } from './uploadFileTypes';
import { readFileHeader, sweepStaleTempFiles } from './overlayFiles';

const log = createLogger('OverlayMovConversion');

/** Suffix of the temporary copy of an uploaded MOV that ffmpeg reads from. */
const SOURCE_SUFFIX = '.mov.upload';

/** Suffix of a WebM while ffmpeg is still writing it; renamed to `.webm` once it's complete. */
const PARTIAL_SUFFIX = '.webm.part';

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
 * Removes temporary conversion files left in `dir` by earlier uploads whose own cleanup failed
 * (see `sweepStaleTempFiles`). Runs before each MOV conversion.
 * @param dir - Absolute path of the streamer's overlay folder.
 * @returns Resolves once the sweep has finished; never rejects.
 */
export function sweepStaleConversionFiles(dir: string): Promise<void> {
  return sweepStaleTempFiles(dir, isConversionTempFile);
}

/** Bytes read from the start of a converted file to check it's a WebM. */
const HEADER_BYTES = 16;

/**
 * Checks that ffmpeg's output is a non-empty WebM before it's published: ffmpeg exiting cleanly
 * doesn't by itself prove it wrote a usable file (an empty or truncated output would otherwise
 * be stored and fail only when the overlay tries to play it).
 * @param fullPath - Absolute path of the converted file.
 * @returns Resolves when the file is a non-empty WebM.
 * @throws If the file is missing, empty, or doesn't start with a WebM (EBML) header.
 */
async function assertWebmOutput(fullPath: string): Promise<void> {
  const header = await readFileHeader(fullPath, HEADER_BYTES);
  if (detectVideoType(header) !== 'webm') {
    throw new Error(`Conversion output ${path.basename(fullPath)} is not a WebM (${header.length} header bytes)`);
  }
}

/**
 * Wraps a conversion failure in the error the upload route reports: `transcode_busy` when the
 * conversion queue was full, `transcode_failed` otherwise.
 * @param err - What the conversion, output check or rename threw.
 * @returns An Error carrying the code for the route's redirect.
 */
function conversionError(err: unknown): Error {
  const busy = err instanceof Error && (err as NodeJS.ErrnoException).code === 'transcode_busy';
  return Object.assign(new Error(busy ? 'Video conversion queue full' : 'Video conversion failed'), {
    code: busy ? 'transcode_busy' : 'transcode_failed',
  });
}

/**
 * Converts an uploaded QuickTime video to `<baseName>.webm` in `dir`. The upload is first put at
 * a temporary `.mov.upload` path in `dir`, which ffmpeg reads (it needs a seekable file: a MOV's
 * index is often at the end). ffmpeg writes to a `.webm.part` file that's checked (see
 * {@link assertWebmOutput}) and renamed once complete, so a half-written or unusable WebM never
 * has a servable name. Both temporary files are removed afterwards; any whose removal fails is
 * picked up by {@link sweepStaleConversionFiles} on a later upload.
 * @param dir - Absolute path of the streamer's overlay folder (already safe-resolved and created).
 * @param baseName - Random base name (no extension) for the stored file.
 * @param placeSource - Puts the uploaded MOV at the path it's given (the temporary copy ffmpeg
 *   reads), e.g. by moving the file Multer stored.
 * @param onProgress - Told the conversion's stage and percentage as it goes (optional).
 * @returns The stored WebM's filename.
 * @throws With `code: 'transcode_busy'` if too many conversions are pending, or
 *   `code: 'transcode_failed'` if ffmpeg can't convert the file or its output isn't a WebM; or
 *   the error from `placeSource` (after removing anything it left at the temporary path).
 */
export async function storeMovAsWebm(
  dir: string,
  baseName: string,
  placeSource: (sourcePath: string) => Promise<void>,
  onProgress?: ProgressListener,
): Promise<string> {
  await sweepStaleConversionFiles(dir);
  const sourcePath = path.join(dir, `${baseName}${SOURCE_SUFFIX}`);
  const partialPath = path.join(dir, `${baseName}${PARTIAL_SUFFIX}`);
  const filename = `${baseName}.webm`;
  try {
    await placeSource(sourcePath);
  } catch (err) {
    await removeQuietly(sourcePath);
    throw err;
  }
  try {
    await transcodeToWebm(sourcePath, partialPath, onProgress);
    await assertWebmOutput(partialPath);
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
