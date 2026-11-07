import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { OVERLAY_FOLDER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { safeResolve, realPathWithin } from '../../shared/pathUtils';

// File operations for the public overlay video library (#907): copying a video between a
// streamer's folder and the library folder, both under OVERLAY_FOLDER, as a hard link where the
// filesystem allows it, and removing a library file. Each side owns its own link, so deleting one
// (fs.promises.rm) never affects the other.

const log = createLogger('OverlayVideoLibraryFiles');

/**
 * Subfolder of OVERLAY_FOLDER holding the library's own copies, `<OVERLAY_FOLDER>/library/`.
 * Can't collide with a streamer's folder: those are named by the streamer's numeric DB id.
 */
export const LIBRARY_FOLDER = 'library';

/** A stored overlay video: the OVERLAY_FOLDER subfolder it lives in and its filename. */
export interface OverlayVideoLocation {
  /** A streamer's folder (from {@link streamerFolder}) or {@link LIBRARY_FOLDER}. */
  folder: string;
  /** Stored filename, e.g. `<uuid>.webm`. */
  filename: string;
}

/**
 * Names a streamer's overlay video folder under OVERLAY_FOLDER.
 * @param streamerId - DB row ID of the streamer.
 * @returns The folder name: the id as a string.
 */
export function streamerFolder(streamerId: number): string {
  return String(streamerId);
}

/**
 * Checks a folder is one this module may read or write: a streamer's numeric folder or the
 * library folder. Anything else (`.incoming`, `..`, a nested path) is refused.
 * @param folder - Candidate OVERLAY_FOLDER subfolder.
 * @returns True if `folder` is a streamer folder or the library folder.
 */
function isVideoFolder(folder: string): boolean {
  return folder === LIBRARY_FOLDER || /^\d+$/.test(folder);
}

/**
 * Resolves OVERLAY_FOLDER subpath segments to a native path, refusing any that would leave
 * OVERLAY_FOLDER. `safeResolve` is the traversal guard; it works in POSIX paths, so the path used
 * for filesystem calls is built separately with the platform `path` (the same on Linux).
 * @param parts - A video folder, optionally followed by a filename.
 * @returns The native absolute path, or null if the folder isn't a video folder or the path
 *   escapes OVERLAY_FOLDER.
 */
function resolveInOverlayFolder(...parts: [string, ...string[]]): string | null {
  if (!isVideoFolder(parts[0])) return null;
  if (!safeResolve(OVERLAY_FOLDER, ...parts)) return null;
  if (parts.slice(1).some((p) => p !== path.basename(p))) return null; // filenames are one segment
  return path.resolve(OVERLAY_FOLDER, ...parts);
}

/**
 * Hard-links `source` to `dest`, falling back to a copy when the link can't be made (another
 * filesystem — `EXDEV` — or a filesystem/permission setup that refuses hard links). The copy
 * refuses to overwrite an existing `dest`.
 * @param source - Real path of the existing file.
 * @param dest - Path of the new file; must not exist.
 * @returns Resolves once `dest` exists with `source`'s contents.
 * @throws If both the link and the copy fail (the copy's error).
 */
async function linkOrCopy(source: string, dest: string): Promise<void> {
  try {
    await fs.promises.link(source, dest);
  } catch (err) {
    log.debug(`Hard link ${source} -> ${dest} failed (${(err as NodeJS.ErrnoException).code}); copying instead`);
    await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
  }
}

/**
 * Gives a stored overlay video a second, independent name in another video folder: resolves and
 * checks the source (following symlinks, so a link pointing outside OVERLAY_FOLDER is refused),
 * creates the destination folder, then hard-links the file under a new UUID filename keeping its
 * extension, or copies it where linking fails. Used for contributor → library and library →
 * streamer.
 * @param source - The existing video's folder and filename.
 * @param destFolder - Folder to put the new file in ({@link streamerFolder} or {@link LIBRARY_FOLDER}).
 * @returns The new file's filename (inside `destFolder`), or null if the source is missing,
 *   outside OVERLAY_FOLDER, or either location isn't a video folder.
 * @throws Filesystem errors from creating the folder or the file.
 */
export async function linkVideoFile(source: OverlayVideoLocation, destFolder: string): Promise<string | null> {
  const sourcePath = resolveInOverlayFolder(source.folder, source.filename);
  const destDir = resolveInOverlayFolder(destFolder);
  if (!sourcePath || !destDir) return null;
  const realSource = await realPathWithin(OVERLAY_FOLDER, sourcePath);
  if (!realSource) return null;

  const filename = `${randomUUID()}${path.extname(source.filename)}`;
  await fs.promises.mkdir(destDir, { recursive: true });
  await linkOrCopy(realSource, path.join(destDir, filename));
  return filename;
}

/**
 * Removes a stored overlay video file, logging instead of throwing (as `removeDeletedVideoFile`
 * does for a deleted video): a leftover file is harmless, a failed request over one isn't worth it.
 * @param location - The file's folder and filename.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function removeVideoFile(location: OverlayVideoLocation): Promise<void> {
  const filePath = resolveInOverlayFolder(location.folder, location.filename);
  if (!filePath) return;
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch (err) {
    log.error(`Failed to remove overlay video file ${filePath}:`, err);
  }
}

/**
 * Removes a library file, e.g. after an Admin removes its library entry.
 * @param filename - The library entry's stored filename.
 * @returns Resolves once removal has been attempted; never rejects.
 */
export async function removeLibraryVideoFile(filename: string): Promise<void> {
  await removeVideoFile({ folder: LIBRARY_FOLDER, filename });
}

/** Outcome of {@link withLinkedVideoFile}. */
export type LinkedVideoFileResult<T> =
  | { status: 'linked'; filename: string; result: T }
  | { status: 'source_missing' };

/**
 * Creates the file first, then runs the DB step that records it, and removes the file again if
 * the DB step throws or its result says the row wasn't written — so a failure can't leave a row
 * without its file, nor (beyond a failed removal, which is logged) a file without its row.
 * @param source - The existing video to link from.
 * @param destFolder - Folder for the new file.
 * @param dbStep - Records the new file, given its filename; its rejection is rethrown after the
 *   file is removed.
 * @param keep - Decides from the DB step's result whether the file stays; defaults to always.
 * @returns `linked` with the new filename and the DB step's result (the file kept or removed per
 *   `keep`), or `source_missing` if {@link linkVideoFile} refused the source (the DB step isn't run).
 * @throws The DB step's error, or a filesystem error from creating the file.
 */
export async function withLinkedVideoFile<T>(
  source: OverlayVideoLocation,
  destFolder: string,
  dbStep: (filename: string) => Promise<T>,
  keep: (result: T) => boolean = () => true,
): Promise<LinkedVideoFileResult<T>> {
  const filename = await linkVideoFile(source, destFolder);
  if (!filename) return { status: 'source_missing' };
  const created = { folder: destFolder, filename };
  let result: T;
  try {
    result = await dbStep(filename);
  } catch (err) {
    await removeVideoFile(created);
    throw err;
  }
  if (!keep(result)) await removeVideoFile(created);
  return { status: 'linked', filename, result };
}
