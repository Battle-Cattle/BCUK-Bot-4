import path from 'path';
import { OVERLAY_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';

/**
 * Subfolder of OVERLAY_FOLDER holding the shared overlay videos, `<OVERLAY_FOLDER>/shared/`
 * (#917). Can't collide with a streamer's folder (named by numeric DB id) or the public library
 * (`library`).
 */
export const SHARED_FOLDER = 'shared';

/**
 * Resolves a shared video's stored filename to its absolute path, refusing anything that is not
 * a single path segment or would leave the shared folder.
 * @param filename - Stored filename, e.g. `<uuid>.webm`.
 * @returns The native absolute path, or null if `filename` is unsafe.
 */
export function resolveSharedVideoPath(filename: string): string | null {
  if (!filename || filename === '.' || filename === '..' || filename !== path.basename(filename)) return null;
  if (!safeResolve(OVERLAY_FOLDER, SHARED_FOLDER, filename)) return null;
  return path.resolve(OVERLAY_FOLDER, SHARED_FOLDER, filename);
}
