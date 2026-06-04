import path from 'path';

/**
 * Resolves `parts` relative to `base` and returns the absolute path, or null
 * if the result would escape `base` (path traversal guard).
 */
export function safeResolve(base: string, ...parts: string[]): string | null {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...parts);
  const rel = path.relative(resolvedBase, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}
