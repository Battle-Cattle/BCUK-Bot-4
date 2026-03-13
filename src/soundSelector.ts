import { SfxFile } from './db';

/**
 * Pick a sound file using weighted-random selection.
 * Files with a higher `weight` value are more likely to be chosen.
 * Falls back to uniform random if all weights are 0 or equal.
 */
export function pickWeightedRandom(files: SfxFile[]): string {
  if (files.length === 0) throw new Error('No files to pick from');
  if (files.length === 1) return files[0].file;

  const totalWeight = files.reduce((sum, f) => sum + (f.weight > 0 ? f.weight : 1), 0);
  let rand = Math.random() * totalWeight;

  for (const file of files) {
    const w = file.weight > 0 ? file.weight : 1;
    rand -= w;
    if (rand <= 0) return file.file;
  }

  // Fallback (floating point edge case)
  return files[files.length - 1].file;
}
