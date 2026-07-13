import { createLogger } from '../../shared/logger';
import fs from 'fs';
import { SFX_FOLDER } from '../../shared/config';
import { safeResolve } from '../../shared/pathUtils';

const log = createLogger('Web');

/**
 * Remove a list of relative sound-file paths from disk in parallel, resolving each safely
 * within SFX_FOLDER. Logs and swallows individual failures so a missing file never blocks
 * the surrounding DB operation, or the removal of any other file in the list.
 */
export async function removeSfxFiles(files: string[]): Promise<void> {
  const results = await Promise.allSettled(
    files.map(async (file) => {
      const fullPath = safeResolve(SFX_FOLDER, file);
      if (!fullPath) return;
      await fs.promises.rm(fullPath, { force: true });
    }),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      log.error(`Failed to remove SFX file ${files[i]}:`, result.reason);
    }
  });
}

