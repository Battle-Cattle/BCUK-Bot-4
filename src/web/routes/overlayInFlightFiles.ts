// Registry of overlay video files whose write is still in progress: created (or about to be) but
// with their DB row not yet committed or given up on. The sweep of files no row refers to
// (`overlayOrphanSweep.ts`) skips these, so a write that stalls between creating its file and
// committing its row (a slow DB, a lock wait, a long cross-device copy) can't have the file swept
// from under it, however long it takes (#966). The bot runs as a single process (CLAUDE.md,
// "Single instance only"), so an in-memory set is enough; after a restart it is rightly empty,
// since nothing from before the restart is still in flight.

/** A stored overlay video's OVERLAY_FOLDER subfolder and filename (see `OverlayVideoLocation`). */
interface VideoFileKey {
  folder: string;
  filename: string;
}

const inFlight = new Set<string>();

/**
 * Builds the one key both the writers and the sweep use for a file.
 * @param location - The file's folder and filename.
 * @returns `<folder>/<filename>`.
 */
function keyOf(location: VideoFileKey): string {
  return `${location.folder}/${location.filename}`;
}

/**
 * Marks a file as in flight for as long as `write` runs, removing the mark when it settles,
 * whether it resolved or threw. Call it before the file is created and keep the DB step (and any
 * removal of the file it decides on) inside `write`.
 * @param location - The folder and filename the write creates.
 * @param write - Creates the file and records (or gives up on) its row.
 * @returns Whatever `write` resolves to.
 * @throws Whatever `write` throws.
 */
export async function withInFlightVideoFile<T>(location: VideoFileKey, write: () => Promise<T>): Promise<T> {
  const key = keyOf(location);
  inFlight.add(key);
  try {
    return await write();
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Checks whether a file's write is still in progress (see {@link withInFlightVideoFile}).
 * @param location - The file's folder and filename.
 * @returns True while the file's write hasn't settled.
 */
export function isVideoFileInFlight(location: VideoFileKey): boolean {
  return inFlight.has(keyOf(location));
}
