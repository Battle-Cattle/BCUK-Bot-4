export interface WeightedFile { file: string; weight: number }

/**
 * Picks one file at random from `files`, weighted by each file's `weight`. Stored weights are
 * always at least 1 (the panel and the advanced-command/overlay writes enforce it, and migration
 * 0006 raised older SFX rows), so a non-positive weight only counts as zero here, never more.
 * @param files Candidate files with their selection weights.
 * @returns The chosen file's path.
 * @throws If `files` is empty.
 */
export function pickWeightedRandom(files: WeightedFile[]): string {
  const last = files.at(-1);
  if (!last) throw new Error('No files to pick from');

  let rand = Math.random() * files.reduce((sum, f) => sum + Math.max(0, f.weight), 0);
  for (const file of files) {
    rand -= Math.max(0, file.weight);
    if (rand <= 0) return file.file;
  }
  // Floating-point rounding can leave `rand` just above zero after the last subtraction.
  return last.file;
}
