export interface WeightedFile { file: string; weight: number }

/**
 * A file's selection weight: its own `weight`, or 1 when that isn't positive.
 * @param file The candidate file.
 * @returns The weight to draw it with.
 */
function effectiveWeight(file: WeightedFile): number {
  return file.weight > 0 ? file.weight : 1;
}

/**
 * Picks one file at random from `files`, weighted by each file's `weight` (non-positive
 * weights are treated as 1).
 * @param files Candidate files with their selection weights.
 * @returns The chosen file's path.
 * @throws If `files` is empty.
 */
export function pickWeightedRandom(files: WeightedFile[]): string {
  const last = files.at(-1);
  if (!last) throw new Error('No files to pick from');

  let rand = Math.random() * files.reduce((sum, f) => sum + effectiveWeight(f), 0);
  for (const file of files) {
    rand -= effectiveWeight(file);
    if (rand <= 0) return file.file;
  }
  // Floating-point rounding can leave `rand` just above zero after the last subtraction.
  return last.file;
}
