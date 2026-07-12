import { createLogger } from '../../shared/logger';
import fs from 'fs';
import { SFX_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';

const log = createLogger('Web');

/**
 * Remove a list of relative sound-file paths from disk, resolving each safely
 * within SFX_FOLDER. Logs and swallows individual failures so a missing file
 * never blocks the surrounding DB operation.
 */
export async function removeSfxFiles(files: string[]): Promise<void> {
  for (const file of files) {
    const fullPath = safeResolve(SFX_FOLDER, file);
    if (!fullPath) continue;
    try {
      await fs.promises.rm(fullPath, { force: true });
    } catch (err) {
      log.error(`Failed to remove SFX file ${file}:`, err);
    }
  }
}

