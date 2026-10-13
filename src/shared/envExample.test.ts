import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

// Read by the code but not meant to be set in .env: NODE_ENV comes from `npm start`, VITEST from
// the test runner, and FFMPEG_PATH is written by sfxPlayer.ts itself (from ffmpeg-static).
const NOT_USER_SETTINGS = new Set(['NODE_ENV', 'VITEST', 'FFMPEG_PATH']);

/** Every non-test .ts file under src/, as repo-relative paths. */
function sourceFiles(dir = path.join(REPO_ROOT, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Env var names the source reads: `process.env.X`, `process.env['X']`, and config.ts's helpers' string arguments. */
function envVarsReadBySource(): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /(?:require_env|parseIntEnvInRange)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  ];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) names.add(match[1]!);
    }
  }
  return names;
}

describe('.env.example', () => {
  it('mentions every setting the code reads, set or commented out', () => {
    const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

    const missing = [...envVarsReadBySource()].filter((name) => !NOT_USER_SETTINGS.has(name) && !documented.has(name));
    expect(missing).toEqual([]);
  });
});
