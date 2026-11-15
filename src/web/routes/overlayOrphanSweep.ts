import fs from 'fs';
import path from 'path';
import { OVERLAY_FOLDER } from '../../shared/config';
import { createLogger } from '../../shared/logger';
import { realPathWithin } from '../../shared/pathUtils';
import { getRecordedLibraryFilenames, getRecordedVideoFilenames } from '../../db';
import { STALE_TEMP_FILE_MS } from './overlayFiles';
import { isVideoFileInFlight } from './overlayInFlightFiles';
import { LIBRARY_FOLDER, removeVideoFile, type OverlayVideoLocation } from './overlayVideoLibraryFiles';

// Sweeps overlay video files that no DB row refers to (#966). Every write creates its file before
// its row (upload, library publish and import) and every delete removes the row before the file
// (video delete, library entry removal), so a process that dies between the two steps, or a
// removal that fails, leaves a file nothing refers to and nothing would ever remove.
//
// Only a streamer's folder (`<OVERLAY_FOLDER>/<streamer id>/`, checked against `overlay_video`) and
// the library folder (`library/`, checked against `overlay_video_library`) are swept, and in them
// only files named like a stored video. Everything else under OVERLAY_FOLDER is left alone:
// `.incoming/` (swept by `sweepStaleTempFiles`), `shared/` (the shared overlay's own videos), MOV
// conversion files (`*.mov.upload`, `*.webm.part`, swept by `storeMovAsWebm`), and symlinks.
//
// What keeps the sweep from racing a write is the in-flight registry (`overlayInFlightFiles.ts`):
// a file is skipped while its write is in progress, and the registry is checked *before* the DB,
// so a write that commits its row and leaves the registry in between is still seen by the query.
// The age margin is only a safety net for files written some other way. Every folder is checked
// before anything is removed, so a run that fails part way removes nothing.

const log = createLogger('OverlayOrphanSweep');

/**
 * A file must have been created (or last linked, `ctime`) at least this long ago to be swept. Not
 * `mtime`: a hard link shares its inode with the source, so a file linked a second ago from an old
 * upload carries the upload's old `mtime`, while `link()` updates `ctime`. As long as the oldest a
 * temporary upload or conversion file can legitimately get.
 */
export const ORPHAN_MIN_AGE_MS = STALE_TEMP_FILE_MS;

/** How often the sweep runs after the one at startup. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** Most filenames looked up in one DB query, so a large folder can't build an unbounded `IN` list. */
const LOOKUP_BATCH_SIZE = 500;

/** Names of stored videos (`<uuid>.webm`/`.mp4`), as served by `overlaySource.ts`. */
const VIDEO_FILENAME_RE = /^[\w-]+\.(webm|mp4)$/i;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;

/**
 * Picks out the folders under OVERLAY_FOLDER this sweep covers: real directories (not symlinks)
 * named as a streamer's numeric id, in its canonical form (no leading zeros), or as the library.
 * @param entry - A directory entry of OVERLAY_FOLDER.
 * @returns True for a streamer folder or the library folder.
 */
function isSweptFolder(entry: fs.Dirent): boolean {
  if (!entry.isDirectory()) return false;
  return entry.name === LIBRARY_FOLDER || (/^\d+$/.test(entry.name) && String(Number(entry.name)) === entry.name);
}

/**
 * Lists a folder's stored-video files old enough to sweep: regular files (not symlinks) with a
 * stored video's name and a `ctime` older than {@link ORPHAN_MIN_AGE_MS}.
 * @param dir - Real path of the folder.
 * @param now - Current time in epoch milliseconds.
 * @returns The filenames.
 */
async function listOldVideoFiles(dir: string, now: number): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const old: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_FILENAME_RE.test(entry.name)) continue;
    try {
      const { ctimeMs } = await fs.promises.lstat(path.join(dir, entry.name));
      if (now - ctimeMs > ORPHAN_MIN_AGE_MS) old.push(entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // removed meanwhile: nothing to sweep
    }
  }
  return old;
}

/**
 * Looks up which of a folder's files have a DB row: `overlay_video_library` for the library,
 * the streamer's `overlay_video` rows otherwise. In batches of {@link LOOKUP_BATCH_SIZE}.
 * @param folder - The folder's name under OVERLAY_FOLDER.
 * @param filenames - Files in it; may be empty.
 * @returns The filenames that have a row.
 * @throws The DB error, so the caller removes nothing it couldn't check.
 */
async function recordedFilenames(folder: string, filenames: string[]): Promise<Set<string>> {
  const recorded = new Set<string>();
  for (let i = 0; i < filenames.length; i += LOOKUP_BATCH_SIZE) {
    const batch = filenames.slice(i, i + LOOKUP_BATCH_SIZE);
    const found = folder === LIBRARY_FOLDER
      ? await getRecordedLibraryFilenames(batch)
      : await getRecordedVideoFilenames(Number(folder), batch);
    for (const filename of found) recorded.add(filename);
  }
  return recorded;
}

/**
 * Finds one folder's orphans: lists its old stored-video files, drops any still being written,
 * then (only then, see the module comment) asks the DB which have a row. Removes nothing.
 * @param folder - The folder's name under OVERLAY_FOLDER.
 * @param now - Current time in epoch milliseconds.
 * @returns The folder's files that no row refers to.
 * @throws A filesystem error listing the folder, or a DB error.
 */
async function findOrphanedFiles(folder: string, now: number): Promise<OverlayVideoLocation[]> {
  const dir = await realPathWithin(OVERLAY_FOLDER, path.resolve(OVERLAY_FOLDER, folder));
  if (!dir) return [];
  const candidates = (await listOldVideoFiles(dir, now)).filter((filename) => !isVideoFileInFlight({ folder, filename }));
  if (candidates.length === 0) return [];
  const recorded = await recordedFilenames(folder, candidates);
  return candidates.filter((filename) => !recorded.has(filename)).map((filename) => ({ folder, filename }));
}

/**
 * Removes overlay video files that no DB row refers to, from every streamer folder and the library
 * folder (see the module comment for what is and isn't touched). Every folder is listed and checked
 * against the DB before anything is removed, so a failure anywhere (a DB outage, a folder it can't
 * list) removes nothing at all.
 * @param now - Current time in epoch milliseconds (injectable for tests).
 * @returns How many files were removed.
 * @throws A filesystem or DB error, before any removal; {@link runSweep} catches it.
 */
export async function sweepOrphanedOverlayVideos(now = Date.now()): Promise<number> {
  const orphans: OverlayVideoLocation[] = [];
  for (const folder of await listSweptFolders()) orphans.push(...await findOrphanedFiles(folder, now));
  // Every folder has passed its checks: only now remove anything.
  for (const orphan of orphans) {
    log.info(`Removing overlay video file ${orphan.folder}/${orphan.filename}: no database row refers to it`);
    await removeVideoFile(orphan);
  }
  return orphans.length;
}

/**
 * Lists the folders under OVERLAY_FOLDER this sweep covers (see {@link isSweptFolder}).
 * @returns Their names, or none if OVERLAY_FOLDER doesn't exist yet.
 * @throws A filesystem error other than a missing OVERLAY_FOLDER.
 */
async function listSweptFolders(): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(OVERLAY_FOLDER, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // nothing uploaded yet
    throw err;
  }
  return entries.filter(isSweptFolder).map((entry) => entry.name);
}

/**
 * Runs {@link sweepOrphanedOverlayVideos}, logging the outcome. Skipped while a previous run is
 * still going.
 * @returns Resolves once the run (or skip) has finished; never rejects.
 */
async function runSweep(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const removed = await sweepOrphanedOverlayVideos();
    log.info(`Overlay video sweep removed ${removed} file(s) no database row refers to`);
  } catch (err) {
    log.warn('Overlay video sweep stopped without finishing; it will try again on its next run:', err);
  } finally {
    sweepRunning = false;
  }
}

/**
 * Starts the sweep: once now, then every {@link SWEEP_INTERVAL_MS}. No-ops if already started.
 */
export function startOverlayOrphanSweep(): void {
  if (sweepTimer) return;
  void runSweep();
  sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  // shutdown() stops it explicitly; unref so it never keeps an otherwise-finished process alive.
  sweepTimer.unref();
}

/** Stops the sweep's schedule, if running. A run already in progress finishes on its own. */
export function stopOverlayOrphanSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

/** Test-only: resets the module's state so each test starts from a clean slate. */
export function __resetOverlayOrphanSweepForTests(): void {
  stopOverlayOrphanSweep();
  sweepRunning = false;
}
