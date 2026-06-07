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
