import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import type { SessionUser } from '../../types/express';
import { getStreamerByDiscordId, type DbStreamerEventSub } from '../../db';
import { getSessionUser } from '../session';

const VIEWS_DIR = path.join(__dirname, '../../../views');
let knownViews: Set<string> | undefined;

/** Lazily reads and caches the set of view names from the `.ejs` files under `views/`. */
function getKnownViews(): Set<string> {
  if (!knownViews) {
    knownViews = new Set(
      fs.readdirSync(VIEWS_DIR)
        .filter((f) => f.endsWith('.ejs'))
        .map((f) => f.slice(0, -'.ejs'.length)),
    );
  }
  return knownViews;
}

/**
 * Keys that must never appear in `renderView`'s `data` argument. Express's EJS integration
 * uses the same object as both template locals and `ejs.compile` options, so an
 * attacker-controlled key here (e.g. `outputFunctionName`) could alter template compilation —
 * a known EJS option-injection class of SSTI. `__proto__`/`constructor`/`prototype` are
 * blocked for the same reason (prototype pollution of the render options object).
 */
const RESERVED_RENDER_DATA_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'cache',
  'filename',
  'views',
  'root',
  'client',
  'escape',
  'compileDebug',
  'debug',
  'delimiter',
  'openDelimiter',
  'closeDelimiter',
  'strict',
  '_with',
  'localsName',
  'rmWhitespace',
  'outputFunctionName',
  'async',
  'destructuredLocals',
  'context',
  'scope',
  'beautify',
  'includer',
  // EJS's `renderFile` special-cases a `settings` key on the data object (for Express 2/3
  // compat): `settings.views`/`settings['view cache']` set compile options directly, and
  // `settings['view options']` is shallow-copied into the real options *without* being
  // filtered by any key list at all. Blocking `settings` outright closes that whole nested
  // bypass rather than trying to enumerate every option it could smuggle through.
  'settings',
]);

/**
 * Renders an EJS view after checking `view` against the actual `.ejs` files present
 * under `views/`. Throws if `view` isn't a real template, so a template name can never
 * be attacker-controlled or silently mistyped. Also validates `data`: it must be a plain
 * object and must not contain any key in {@link RESERVED_RENDER_DATA_KEYS}, preventing a
 * caller from ever smuggling EJS compile-option or prototype-pollution keys into the
 * render call.
 * @param res - Express response object.
 * @param view - Name of the view to render (without the `.ejs` extension).
 * @param data - Template data, forwarded to `res.render` unchanged once validated.
 */
export function renderView(res: Response, view: string, data?: Record<string, unknown>): void {
  if (!getKnownViews().has(view)) {
    throw new Error(`renderView: unknown view "${view}"`);
  }
  if (data !== undefined) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('renderView: data must be a plain object');
    }
    for (const key of Object.keys(data)) {
      if (RESERVED_RENDER_DATA_KEYS.has(key)) {
        throw new Error(`renderView: data contains reserved key "${key}"`);
      }
    }
  }
  res.render(view, data);
}

/**
 * Renders the `error` EJS view with the given HTTP status and message.
 * @param res - Express response object.
 * @param status - HTTP status code to set.
 * @param message - Human-readable error message shown to the user.
 * @param sessionUser - Current session user, or `undefined` if unauthenticated.
 */
export function renderError(
  res: Response,
  status: number,
  message: string,
  sessionUser: SessionUser | undefined,
): void {
  res.status(status);
  renderView(res, 'error', { message, user: sessionUser ?? null, csrfToken: '' });
}

/**
 * Loads the requesting user's streamer record, redirecting to `notAStreamerRedirectPath`
 * if they aren't one. Shared by every streamer-scoped admin page (channel points, overlay
 * settings), each of which passes its own not-a-streamer error redirect so the pages stay
 * decoupled from one another.
 * @param req - Express request; reads `session.user.discordId`.
 * @param res - Express response, used to redirect on failure.
 * @param notAStreamerRedirectPath - Full redirect target (path + query string) to use when
 *   the requester has no streamer record.
 * @returns The streamer record, or `null` if the response has already been redirected.
 */
export async function requireStreamer(
  req: Request,
  res: Response,
  notAStreamerRedirectPath: string,
): Promise<DbStreamerEventSub | null> {
  const streamer = await getStreamerByDiscordId(getSessionUser(req).discordId);
  if (!streamer) {
    res.redirect(notAStreamerRedirectPath);
    return null;
  }
  return streamer;
}
