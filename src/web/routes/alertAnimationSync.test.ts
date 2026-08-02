import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// The '../../db' facade transitively pulls in '../../shared/config' (which requires real env
// vars) and '../../db/pool' / '../../db/alertConfigCache' (which need a live DB connection) at
// module scope. Stub all three with safe dummy values so the *real* ALERT_TEXT_ANIMATIONS from
// db/alertConfig.ts loads through the facade — keeping this test pinned to the authoritative
// list instead of a hand-copied duplicate that could silently drift from it.
vi.mock('../../shared/config', () => ({
  DISCORD_TOKEN: 'mock-token',
  TWITCH_USERNAME: 'mock-user',
  TWITCH_OAUTH_TOKEN: 'oauth:mock',
  TWITCH_CLIENT_ID: 'mock-client-id',
  TWITCH_CLIENT_SECRET: 'mock-client-secret',
  DB_HOST: 'localhost',
  DB_PORT: 3306,
  DB_USER: 'mock-user',
  DB_PASSWORD: 'mock-password',
  DB_NAME: 'mock-db',
  SESSION_SECRET: 'mock-session-secret-that-is-long-enough',
  DISCORD_CLIENT_ID: 'mock-discord-client-id',
  DISCORD_CLIENT_SECRET: 'mock-discord-client-secret',
  DISCORD_CALLBACK_URL: 'http://localhost:3000/auth/discord/callback',
  PUBLIC_URL: 'http://localhost:3000',
}));
vi.mock('../../db/pool', () => ({ getPool: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../db/alertConfigCache', () => ({ invalidateAlertConfigLookupCache: vi.fn(), findCachedAlertConfig: vi.fn() }));

import { ALERT_TEXT_ANIMATIONS } from '../../db';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Reads a repo-relative file's contents as UTF-8 text. */
function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Extracts the text between the first `{`/`}` pair found after `marker` in `source`. */
function extractBraceBlock(source: string, marker: string): string {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) throw new Error(`marker not found: ${marker}`);
  const start = source.indexOf('{', markerIdx);
  if (start === -1) throw new Error(`'{' not found after marker: ${marker}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced braces after marker: ${marker}`);
}

/** Extracts the text between the first `[`/`]` pair found after `marker` in `source`. */
function extractBracketBlock(source: string, marker: string): string {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) throw new Error(`marker not found: ${marker}`);
  const start = source.indexOf('[', markerIdx);
  if (start === -1) throw new Error(`'[' not found after marker: ${marker}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced brackets after marker: ${marker}`);
}

/** Extracts object-literal key names (quoted or bare) from a `{ ... }` block's inner text. */
function extractObjectKeys(objectBody: string): string[] {
  return [...objectBody.matchAll(/(?:'([^']+)'|(\w[\w-]*))\s*:/g)].map((m) => m[1] ?? m[2]);
}

/** Extracts single-quoted string literals from an array-literal block's inner text. */
function extractQuotedStrings(arrayBody: string): string[] {
  return [...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Every alert text animation other than 'none' (which renders as plain unrecognised/no-op text,
// deliberately absent from the tables/classes below) must be wired up everywhere a new
// animation needs registering by hand: public/alerts-overlay.js's two lookup tables (which
// animation family it belongs to), public/alertsOverlaySource.css's `.anim-*` classes (the
// actual CSS driving it), and views/alertsAdmin.ejs's label map (the dropdown's display text).
// None of these are linked to `ALERT_TEXT_ANIMATIONS` at compile time (public/*.js and
// views/*.ejs aren't built from src/db/alertConfig.ts), so a forgotten entry silently falls
// through to "no animation" (or a literal "undefined" label) with no error anywhere — this test
// is the guard against that drift.
const nonNoneAnimations = ALERT_TEXT_ANIMATIONS.filter((anim) => anim !== 'none');

describe('alert text animation cross-file consistency', () => {
  const overlayJs = readRepoFile('public/alerts-overlay.js');
  const overlayCss = readRepoFile('public/alertsOverlaySource.css');
  const adminEjs = readRepoFile('views/alertsAdmin.ejs');

  it('every non-none animation is registered in exactly one of alerts-overlay.js\'s lookup tables', () => {
    const perLetterKeys = extractObjectKeys(extractBraceBlock(overlayJs, 'PER_LETTER_ANIMATION_STEP_S'));
    const wholeElementItems = extractQuotedStrings(extractBracketBlock(overlayJs, 'WHOLE_ELEMENT_ANIMATIONS'));

    const overlap = perLetterKeys.filter((a) => wholeElementItems.includes(a));
    expect(overlap).toEqual([]);

    const handled = new Set([...perLetterKeys, ...wholeElementItems]);
    expect(handled).toEqual(new Set(nonNoneAnimations));
  });

  it('every non-none animation has a matching `.anim-<name>` CSS class in alertsOverlaySource.css', () => {
    const cssAnimationClasses = new Set(
      [...overlayCss.matchAll(/\.anim-([\w-]+)/g)].map((m) => m[1]),
    );
    for (const anim of nonNoneAnimations) {
      expect(cssAnimationClasses.has(anim)).toBe(true);
    }
  });

  it('every non-none animation has a display label in alertsAdmin.ejs\'s animationLabels map', () => {
    const labelKeys = extractObjectKeys(extractBraceBlock(adminEjs, 'animationLabels'));
    expect(new Set(labelKeys)).toEqual(new Set(ALERT_TEXT_ANIMATIONS));
  });
});
