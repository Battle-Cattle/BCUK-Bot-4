export interface WeightedFile { file: string; weight: number }

/**
 * Picks one file at random from `files`, weighted by each file's `weight`. Stored weights are
 * always at least 1 (the panel and the advanced-command/overlay writes enforce it, and migration
 * 0006 raised older SFX rows), so a file with a non-positive weight is never picked while any
 * file has a positive one; if none does, every file is equally likely.
 * @param files Candidate files with their selection weights.
 * @returns The chosen file's path.
 * @throws If `files` is empty.
 */
export function pickWeightedRandom(files: WeightedFile[]): string {
  const last = files.at(-1);
  if (!last) throw new Error('No files to pick from');

  const weighted = files.filter((f) => f.weight > 0);
  const lastWeighted = weighted.at(-1);
  if (!lastWeighted) return files[Math.floor(Math.random() * files.length)]?.file ?? last.file;

  let rand = Math.random() * weighted.reduce((sum, f) => sum + f.weight, 0);
  for (const file of weighted) {
    rand -= file.weight;
    if (rand <= 0) return file.file;
  }
  // Floating-point rounding can leave `rand` just above zero after the last subtraction.
  return lastWeighted.file;
}
