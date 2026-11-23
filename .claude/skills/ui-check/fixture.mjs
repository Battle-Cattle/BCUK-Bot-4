// ui-check fixture loading: `extends` (deep-merge over a base fixture) and the `status` shorthand.
// See the "Fixtures" section of SKILL.md next to this file.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The value that removes an inherited key in a variant (`null` can't: status payloads use real nulls). */
export const REMOVE = '$remove';

/**
 * Says whether a value is a plain JSON object (not an array or null).
 * @param value - Any parsed JSON value.
 * @returns True for `{…}` objects.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `over` onto `base` without changing either: objects merge key by key, arrays and scalars
 * replace (`null` included), and `"$remove"` in `over` deletes that key, so a variant can drop
 * something it inherits.
 * @param base - The inherited value.
 * @param over - The overriding value.
 * @returns A new merged value.
 */
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredClone(over);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    if (value === REMOVE) delete merged[key];
    else merged[key] = deepMerge(key in merged ? merged[key] : {}, value);
  }
  return merged;
}

/**
 * Reads a fixture and, when it has `extends`, merges it over its base (recursively; a base path is
 * relative to the fixture that names it).
 * @param fixturePath - Path to the fixture JSON.
 * @param seen - Absolute paths already on this `extends` chain, to refuse a cycle.
 * @returns The fixture with every base merged in and `extends` removed.
 */
async function readWithBases(fixturePath, seen = []) {
  const absolute = path.resolve(fixturePath);
  if (seen.includes(absolute)) throw new Error(`fixture extends cycle: ${[...seen, absolute].join(' -> ')}`);
  const own = JSON.parse(await readFile(absolute, 'utf8'));
  if (own.extends === undefined) return own;
  if (typeof own.extends !== 'string') throw new Error(`${fixturePath}: "extends" must be a path to another fixture`);
  const base = await readWithBases(path.resolve(path.dirname(absolute), own.extends), [...seen, absolute]);
  return deepMerge(base, { ...own, extends: REMOVE });
}

/**
 * Applies the `status` shorthand: merges one status payload into `locals.status` (the initial render),
 * into each `api` stub named in `statusPaths.api` (fetch) and into every event of each `sse` stub
 * named in `statusPaths.sse` (the stream), so a state is stated once and holds on every update path.
 * A stream with no events gets one carrying the status. Without `statusPaths` only `locals` is set,
 * so the page's fetch and stream fall through to 503.
 * @param fixture - The merged fixture.
 * @returns The fixture with the status applied and the shorthand keys removed.
 */
export function applyStatus(fixture) {
  const { status, statusPaths, ...rest } = fixture;
  if (status === undefined) return rest;
  const out = deepMerge(rest, { locals: {}, api: {}, sse: {} });
  out.locals.status = deepMerge(out.locals.status ?? {}, status);
  for (const apiPath of statusPaths?.api ?? []) out.api[apiPath] = deepMerge(out.api[apiPath] ?? {}, status);
  for (const ssePath of statusPaths?.sse ?? []) {
    const events = out.sse[ssePath] ?? [];
    out.sse[ssePath] = events.length === 0
      ? [{ data: structuredClone(status) }]
      : events.map((e) => ({ ...e, data: deepMerge(e.data ?? {}, status) }));
  }
  return out;
}

/**
 * Reads and validates a fixture file, resolving `extends` and the `status` shorthand.
 * @param fixturePath - Path to the fixture JSON: `{ view, locals?, api?, sse?, waitMs?, extends?, status?, statusPaths?, clock?, sessionStorage? }`.
 * @returns The fixture as the renderer uses it, with defaults filled in.
 */
export async function loadFixture(fixturePath) {
  const fixture = applyStatus(await readWithBases(fixturePath));
  if (typeof fixture.view !== 'string' || !/^[\w-]+$/.test(fixture.view)) {
    throw new Error('fixture.view must be the name of a file in views/ (e.g. "dashboard")');
  }
  return { locals: {}, api: {}, sse: {}, waitMs: 500, clock: null, sessionStorage: null, ...fixture };
}
