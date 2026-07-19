import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const log = createLogger('ServiceWorker');
const router = Router();

const PUBLIC_DIR = path.join(__dirname, '../../../public');
const SERVICE_WORKER_TEMPLATE_PATH = path.join(PUBLIC_DIR, 'service-worker.js');
const CACHE_VERSION_PLACEHOLDER = '__CACHE_VERSION__';

// Excluded from the version hash: `downloads/` holds runtime-generated content unrelated to
// app code, and service-worker.js itself is excluded so hashing doesn't depend on its own
// not-yet-substituted placeholder text.
const HASH_EXCLUDED_TOP_LEVEL_ENTRIES = new Set(['downloads', 'service-worker.js']);

/**
 * Recursively lists every file under `dir`, as paths relative to `rootDir`, skipping any
 * entry whose top-level (relative to `rootDir`) path segment is in
 * {@link HASH_EXCLUDED_TOP_LEVEL_ENTRIES}. Also skips any entry whose real (symlink-resolved)
 * path escapes `rootDir` — a containment check against `fs.realpathSync`, not just the literal
 * path string, since a symlink inside `rootDir` can point anywhere on disk and a naive
 * `path.relative`/`path.resolve` check never follows it. This guards against a future caller
 * passing untrusted `rootDir`/`dir` values, which could otherwise read outside the intended tree.
 * @param rootDir - The directory relative paths (and the exclusion/containment checks) are
 *   computed against. Resolved once per top-level call.
 * @param dir - Directory to walk on this call (absolute path); defaults to `rootDir` for the
 *   initial call, and is the current subdirectory on recursive calls.
 * @param realRoot - The symlink-resolved form of `rootDir`, threaded through recursive calls so
 *   it's only computed once; callers should omit this.
 * @returns Relative file paths, in directory-listing order (not yet sorted).
 */
function listFilesRecursive(
  rootDir: string,
  dir: string = rootDir,
  realRoot: string = fs.realpathSync(rootDir),
): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.resolve(dir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      continue;
    }
    const realPath = fs.realpathSync(absolutePath);
    const realRelativePath = path.relative(realRoot, realPath);
    if (
      realRelativePath === '..' ||
      realRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelativePath)
    ) {
      continue;
    }
    const topLevelSegment = relativePath.split(path.sep)[0];
    if (HASH_EXCLUDED_TOP_LEVEL_ENTRIES.has(topLevelSegment)) continue;
    if (entry.isDirectory()) files.push(...listFilesRecursive(rootDir, absolutePath, realRoot));
    else files.push(relativePath);
  }
  return files;
}

/**
 * Computes a short content hash of every file under `publicDir` (excluding `downloads/` and
 * `service-worker.js` itself), used as the service worker's cache-busting version — so any
 * static-asset change automatically invalidates old caches, with no version string to
 * remember to bump by hand.
 * @param publicDir - Directory to hash (defaults to this app's `public/`; overridable for tests).
 * @returns A 16-character hex digest.
 */
export function computeStaticAssetsVersion(publicDir: string = PUBLIC_DIR): string {
  const hash = createHash('sha256');
  for (const relativePath of listFilesRecursive(publicDir).sort()) {
    hash.update(relativePath);
    hash.update(fs.readFileSync(path.join(publicDir, relativePath)));
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Substitutes every occurrence of the `__CACHE_VERSION__` placeholder in `template` with
 * `version`.
 * @param template - The service worker source, containing the literal placeholder text.
 * @param version - The computed cache version to substitute in.
 * @returns The service worker source with the placeholder replaced.
 */
export function renderServiceWorker(template: string, version: string): string {
  return template.split(CACHE_VERSION_PLACEHOLDER).join(version);
}

// Computed once at startup — public/ only changes between deploys (process restarts), not
// while the process is running. A failure here (e.g. a missing public/ dir in some unusual
// deployment) falls back to serving the raw, unsubstituted template rather than crashing
// startup — the service worker still functions, just without automatic cache invalidation.
let serviceWorkerBody: string;
try {
  const template = fs.readFileSync(SERVICE_WORKER_TEMPLATE_PATH, 'utf8');
  serviceWorkerBody = renderServiceWorker(template, computeStaticAssetsVersion());
} catch (err) {
  log.error('Failed to prepare service-worker.js — serving the unsubstituted template as a fallback:', err);
  serviceWorkerBody = fs.readFileSync(SERVICE_WORKER_TEMPLATE_PATH, 'utf8');
}

/**
 * GET /service-worker.js — serves the service worker script with its cache-version
 * placeholder substituted for a content hash of every file in `public/`. `Cache-Control:
 * no-cache` ensures the browser always revalidates with the server before reusing a cached
 * copy of this script, so an updated hash is never masked by HTTP-level caching stacked on
 * top of the service worker's own update-check cycle.
 * @param _req - Express request (unused).
 * @param res - Express response; sends the substituted service worker source.
 */
router.get('/service-worker.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(serviceWorkerBody);
});

export default router;
