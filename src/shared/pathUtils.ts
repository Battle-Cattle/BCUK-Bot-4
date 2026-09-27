import fs from 'fs';
import path from 'path';

/**
 * Resolves `parts` relative to `base` and returns the absolute path, or null
 * if the result would escape `base` (path traversal guard).
 *
 * Uses path.posix so behaviour is consistent across platforms (base paths are
 * always POSIX-style since the bot targets Linux).
 */
export function safeResolve(base: string, ...parts: string[]): string | null {
  const resolvedBase = path.posix.resolve(base);
  const target = path.posix.resolve(resolvedBase, ...parts);
  const rel = path.posix.relative(resolvedBase, target);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  return target;
}

/**
 * Follows symlinks for `candidate` — a path already checked lexically against `base` with
 * {@link safeResolve}, which doesn't touch the filesystem — and returns its real path only if it
 * exists and still lies inside the real `base`. Guards file-serving routes against a symlink
 * (or directory link) under `base` that points outside it, which `res.sendFile` would follow.
 * @param base - Directory the file must live under (need not be canonical; it's resolved too).
 * @param candidate - Path to check, normally `safeResolve(base, ...)`'s result.
 * @returns The canonical real path, or null if either path doesn't exist or the real path
 *   escapes `base`.
 * @throws Filesystem errors other than a missing path (e.g. `EACCES`) from `fs.promises.realpath`.
 */
export async function realPathWithin(base: string, candidate: string): Promise<string | null> {
  let realBase: string;
  let real: string;
  try {
    [realBase, real] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(candidate)]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  // Platform `path` (not posix): realpath returns native paths, e.g. `C:\...` on Windows.
  const rel = path.relative(realBase, real);
  if (rel === '' || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) return null;
  return real;
}
