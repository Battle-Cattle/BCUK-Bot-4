import fs from 'fs';
import path from 'path';
import { ALERT_ASSETS_FOLDER, OVERLAY_FOLDER, SFX_FOLDER, UPLOAD_INCOMING_FOLDER } from './config';
import { createLogger } from './logger';

// The files the web panel serves from these folders are checked for containment (realpath) and
// then opened again by sendFile/createReadStream, so a path component swapped for a symlink in
// between would be followed (see `streamerFileServing.ts`). Doing that needs write access to the
// folder, which under the documented deployment (README, "Deployment") means already being the
// bot's user. This startup check flags a deployment that doesn't follow that guidance (#1059).

const log = createLogger('UploadFolders');

/** Mode bits for group- and world-writable (`S_IWGRP | S_IWOTH`). */
const GROUP_OR_WORLD_WRITABLE = 0o022;

/** The parts of `fs.Stats` this check reads. */
interface FolderStats {
  mode: number;
  uid: number;
}

/** Overrides for {@link checkUploadFolderPermissions}, so tests can stub the platform, uid and `stat`. */
export interface UploadFolderCheckOptions {
  /** Platform to check for; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The process's uid; defaults to `process.getuid()`. */
  uid?: number;
  /** `stat` implementation; defaults to `fs.promises.stat`. */
  stat?: (target: string) => Promise<FolderStats>;
  /** The folders to check, by setting name; defaults to {@link uploadFolders}. */
  folders?: Record<string, string>;
}

/**
 * The folders the bot stores uploads in and serves files from, keyed by the setting that names them.
 * @returns Each setting's name mapped to its configured folder.
 */
export function uploadFolders(): Record<string, string> {
  return { OVERLAY_FOLDER, ALERT_ASSETS_FOLDER, SFX_FOLDER, UPLOAD_INCOMING_FOLDER };
}

/**
 * Describes what's wrong with a folder's permissions.
 * @param stats - The folder's mode and owner uid.
 * @param uid - The bot process's uid.
 * @returns The problems found (e.g. "writable by group or others"), empty if none.
 */
export function describePermissionProblems(stats: FolderStats, uid: number): string[] {
  const problems: string[] = [];
  if ((stats.mode & GROUP_OR_WORLD_WRITABLE) !== 0) {
    problems.push(`writable by group or others (mode ${(stats.mode & 0o777).toString(8).padStart(3, '0')})`);
  }
  if (stats.uid !== uid) problems.push(`owned by uid ${stats.uid}, not the bot's uid ${uid}`);
  return problems;
}

/**
 * Checks one folder, returning a warning line if its permissions are unsafe. A folder that doesn't
 * exist yet (created on first upload) is skipped; any other `stat` failure is logged and skipped.
 * @param name - The setting that names the folder, for the message.
 * @param folder - The configured folder path.
 * @param uid - The bot process's uid.
 * @param stat - The `stat` implementation.
 * @returns The warning line, or null if the folder is fine, missing or couldn't be checked.
 */
async function checkFolder(
  name: string, folder: string, uid: number, stat: (target: string) => Promise<FolderStats>,
): Promise<string | null> {
  const target = path.resolve(folder);
  let stats: FolderStats;
  try {
    stats = await stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Couldn't check the permissions of ${name} (${target}):`, err);
    return null;
  }
  const problems = describePermissionProblems(stats, uid);
  return problems.length ? `${name} (${target}) is ${problems.join(' and ')}` : null;
}

/**
 * Warns, in the log and through `alert` (an owner DM in production), when an upload folder is
 * group- or world-writable or owned by another user: anyone else who can write there could race
 * the served-file containment check. Skipped on Windows, which has no POSIX modes or uids.
 * @param alert - Sends the owner one alert listing every unsafe folder.
 * @param options - Test overrides; see {@link UploadFolderCheckOptions}.
 * @returns The warning lines (one per unsafe folder), empty if all are fine or the check was skipped.
 */
export async function checkUploadFolderPermissions(
  alert: (message: string) => Promise<unknown>, options: UploadFolderCheckOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  if (platform === 'win32' || uid === undefined) return [];
  const stat = options.stat ?? ((target: string) => fs.promises.stat(target));
  const folders = Object.entries(options.folders ?? uploadFolders());
  const results = await Promise.all(folders.map(([name, folder]) => checkFolder(name, folder, uid, stat)));
  const warnings = results.filter((line): line is string => line !== null);
  if (warnings.length === 0) return [];
  for (const line of warnings) log.warn(`Unsafe upload folder permissions: ${line}`);
  const fix = 'Make each folder owned and writable only by the bot\'s user, e.g. `chown -R <bot user> <folder> && chmod -R go-w <folder>` (README, "Deployment").';
  const list = warnings.map((line) => `• ${line}`).join('\n');
  await alert(`⚠️ Unsafe upload folder permissions:\n${list}\n${fix}`);
  return warnings;
}
