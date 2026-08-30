import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ensureSessionCsrfToken } from './csrf';
import {
  AccessLevel,
  findKeyByHash,
  findDiscordIdByTokenHash,
  findUser,
  type DbUser,
} from '../db';
import { renderView } from './routes/viewHelpers';
import { fetchLiveGuildsForUser, resolveAccessLevelForGuild, type LiveGuildsResult } from './guildAccess';

/** How long a user's DB row + live guild/access-level list is cached before being re-fetched. */
const GUILD_CONTEXT_CACHE_TTL_MS = 20_000;

interface CachedGuildContext {
  dbUser: DbUser | null;
  liveGuilds: LiveGuildsResult;
  fetchedAt: number;
}

/**
 * `requireGuildContext` runs on every guild-scoped request and always re-derives membership
 * and access level from the DB (see its doc comment for why), which costs a `findUser` plus a
 * `getAllGuilds`/`getGuildsForMember` round trip per request. Membership and owner status only
 * change on an admin action, so — mirroring `guildScopedStatus.ts`'s identical tradeoff — this
 * caches that pair per user for a short TTL instead of paying it on every request. Deliberately
 * TTL-only (not invalidated on every membership write): a few seconds of staleness before a
 * revoked membership takes effect is an acceptable tradeoff against touching every such write path.
 */
const guildContextCache = new Map<string, CachedGuildContext>();

/**
 * Users with a fetch already in flight — coalesces concurrent cache misses (e.g. several tabs
 * loading guild-scoped pages for the same user before the first fetch resolves) onto a single
 * `findUser`/`fetchLiveGuildsForUser` pair, instead of each request firing its own.
 */
const guildContextInFlight = new Map<string, Promise<CachedGuildContext>>();

/** Test-only: clears the guild-context cache so DB mocks aren't shadowed across test cases. */
export function clearGuildContextCache(): void {
  guildContextCache.clear();
  guildContextInFlight.clear();
}

/**
 * Returns `discordId`'s cached DB user + live guild/access-level list, refreshing it (via
 * `findUser`/`fetchLiveGuildsForUser`) when missing or past `GUILD_CONTEXT_CACHE_TTL_MS`.
 * Concurrent calls for the same stale/missing user share one in-flight fetch instead of each
 * firing their own.
 * @param discordId - Discord snowflake of the session user to look up.
 * @returns The cached (or freshly fetched) DB user and live guild/access-level list.
 */
async function getCachedGuildContext(discordId: string): Promise<CachedGuildContext> {
  const cached = guildContextCache.get(discordId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < GUILD_CONTEXT_CACHE_TTL_MS) {
    return cached;
  }

  const inFlight = guildContextInFlight.get(discordId);
  if (inFlight) return inFlight;

  const load = (async (): Promise<CachedGuildContext> => {
    try {
      const dbUser = await findUser(discordId);
      const liveGuilds = dbUser
        ? await fetchLiveGuildsForUser(dbUser)
        : { guilds: [], accessLevelByGuildId: null };
      const context: CachedGuildContext = { dbUser, liveGuilds, fetchedAt: Date.now() };
      guildContextCache.set(discordId, context);
      return context;
    } finally {
      guildContextInFlight.delete(discordId);
    }
  })();
  guildContextInFlight.set(discordId, load);
  return load;
}

/**
 * Ensures the request has a logged-in session user, redirecting to login otherwise.
 * @param req - Express request; checked for `req.session.user`.
 * @param res - Express response; used to redirect when no session user is present.
 * @param next - Called when a session user is present.
 * @returns Nothing; either calls `next()` or issues a redirect.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/auth/login');
  }
}

/**
 * Ensures the session has a current guild selected before a guild-scoped route runs.
 * Assumes `requireAuth` ran first. Auto-selects when the user has exactly one guild
 * (so single-guild deployments never see the picker); redirects to the picker when a
 * choice is required; and re-validates that the stored guild is still one the user
 * belongs to. Membership and owner status are re-read from the database on every call
 * (rather than trusted from the session cache) so a revoked guild membership or owner
 * flag takes effect immediately instead of only at next login. The effective access
 * level is recomputed for the resolved guild so authorization always reflects the
 * current guild, never a stale login-time value.
 *
 * Guild fetching and access-level resolution are shared with `POST /guild/select` via
 * `fetchLiveGuildsForUser`/`resolveAccessLevelForGuild` (`./guildAccess`) — see those for
 * why a non-owner's access level never needs a second `guild_member` query.
 *
 * @param req - Express request; reads and mutates `req.session.user`.
 * @param res - Express response; used to redirect when no guild context can be resolved.
 * @param next - Called once a valid `currentGuildId` and `accessLevel` are set on the session user.
 * @returns A promise that resolves once `next()` or a redirect has been issued.
 */
export async function requireGuildContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.session.user;
  if (!user) {
    res.redirect('/auth/login');
    return;
  }

  const { dbUser, liveGuilds: { guilds: liveGuilds, accessLevelByGuildId } } = await getCachedGuildContext(user.discordId);
  if (!dbUser) {
    res.redirect('/auth/login');
    return;
  }

  user.isOwner = dbUser.is_owner;
  user.guilds = liveGuilds.map((g) => ({ guildId: g.guild_id, name: g.name }));

  // A stored guild must still be one the user can act in (membership may have been
  // revoked since login). Drop it and re-pick if not.
  if (user.currentGuildId && !user.guilds.some((g) => g.guildId === user.currentGuildId)) {
    user.currentGuildId = null;
  }

  if (!user.currentGuildId) {
    if (user.guilds.length === 0) {
      res.redirect('/auth/login');
      return;
    }
    if (user.guilds.length === 1) {
      user.currentGuildId = user.guilds[0].guildId;
    } else {
      res.redirect('/guild/select');
      return;
    }
  }

  user.accessLevel = await resolveAccessLevelForGuild(dbUser, user.currentGuildId, accessLevelByGuildId);

  next();
}

/**
 * Creates a middleware that ensures the current-guild access level is at least `level`,
 * otherwise renders a 403. Shared factory behind `requireMod`/`requireManager`/`requireAdmin`.
 * @param level - Minimum required `AccessLevel` value.
 * @param label - Requirement described in the 403 message, e.g. `'Manager or above'`.
 * @returns An Express middleware: calls `next()` when the session user meets `level`,
 *   otherwise renders a 403 error page.
 */
function requireAccessLevel(level: number, label: string): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.session.user && req.session.user.accessLevel >= level) {
      next();
    } else {
      res.status(403);
      renderView(res, 'error', {
        message: `Access denied — ${label} required.`,
        user: req.session.user ?? null,
        csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
      });
    }
  };
}

/** Ensures the current-guild access level is Mod or above, otherwise renders a 403. */
export const requireMod = requireAccessLevel(AccessLevel.MOD, 'Mod or above');

/** Ensures the current-guild access level is Manager or above, otherwise renders a 403. */
export const requireManager = requireAccessLevel(AccessLevel.MANAGER, 'Manager or above');

/**
 * Creates a middleware that ensures the current-guild access level is at least `level`,
 * otherwise responds `403 { error: 'forbidden' }`. JSON counterpart to
 * {@link requireAccessLevel}, for routes whose handlers respond with `res.json(...)`
 * rather than rendering a view.
 * @param level - Minimum required `AccessLevel` value.
 * @returns An Express middleware: calls `next()` when the session user meets `level`,
 *   otherwise sends a 403 JSON response.
 */
function requireAccessLevelJson(level: number): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.session.user && req.session.user.accessLevel >= level) {
      next();
    } else {
      res.status(403).json({ error: 'forbidden' });
    }
  };
}

/** Ensures the current-guild access level is Mod or above, otherwise sends a 403 JSON response. */
export const requireModJson = requireAccessLevelJson(AccessLevel.MOD);

/** Ensures the current-guild access level is Manager or above, otherwise sends a 403 JSON response. */
export const requireManagerJson = requireAccessLevelJson(AccessLevel.MANAGER);

/**
 * Creates a middleware that authenticates a request via a `Bearer` token: hashes it with
 * SHA-256, resolves the hash to an identity via `lookup`, and stores it on `req` via `assign`
 * on success. Responds 401 when the header is missing/empty or `lookup` finds no match, and
 * 500 on any other lookup failure. Shared factory behind `requireApiKey`/`requireCompanionKey`.
 * @param lookup - Resolves a SHA-256 hex hash to the authenticated identity, or null if no match.
 * @param assign - Stores the resolved identity on `req` for downstream handlers.
 * @returns An Express middleware.
 */
function authenticateBearerToken<T>(
  lookup: (hash: string) => Promise<T | null>,
  assign: (req: Request, value: T) => void,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const hash = createHash('sha256').update(token).digest('hex');
    try {
      const value = await lookup(hash);
      if (value === null) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      assign(req, value);
      next();
    } catch {
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  };
}

/**
 * Authenticates a Streamdeck API request via a `Bearer` token, hashing it and looking it
 * up by identity only. On success, attaches the key owner's Discord ID to the request —
 * the same key may be approved for more than one guild (or none yet), so each route must
 * resolve its own target guild and check {@link isKeyApprovedForGuild} before acting.
 */
export const requireApiKey = authenticateBearerToken(
  async (hash) => (await findKeyByHash(hash))?.discordId ?? null,
  (req, discordId: string) => { req.apiKeyOwner = discordId; },
);

/**
 * Authenticates a companion app request via a `Bearer` token, hashing it and looking it
 * up against active (non-revoked) companion tokens. On success, attaches the token
 * owner's Discord ID to the request.
 */
export const requireCompanionKey = authenticateBearerToken(
  findDiscordIdByTokenHash,
  (req, discordId: string) => { req.companionDiscordId = discordId; },
);

/** Ensures the current-guild access level is Admin, otherwise renders a 403. */
export const requireAdmin = requireAccessLevel(AccessLevel.ADMIN, 'Admin');

/** Ensures the current-guild access level is Admin, otherwise sends a 403 JSON response. */
export const requireAdminJson = requireAccessLevelJson(AccessLevel.ADMIN);

/**
 * Ensures the session user is the bot owner (`user.is_owner`), otherwise renders a
 * 403. Distinct from {@link requireAdmin}: `isOwner` is a global super-admin flag set
 * manually in the DB (see `user.is_owner` in schema.sql), not a per-guild `AccessLevel`
 * — an Admin in a given guild is not necessarily the owner. Used to gate features
 * still being trialled to the single most-trusted account before a wider rollout.
 * @param req - Express request; checked for `req.session.user?.isOwner`.
 * @param res - Express response; used to render a 403 error page when denied.
 * @param next - Called when the session user is the owner.
 * @returns Nothing; either calls `next()` or renders the error view with a 403 status.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user?.isOwner) {
    next();
  } else {
    res.status(403);
    renderView(res, 'error', {
      message: 'Access denied — Owner required.',
      user: req.session.user ?? null,
      csrfToken: req.session?.user ? ensureSessionCsrfToken(req) : '',
    });
  }
}

/**
 * Same check as {@link requireOwner}, for JSON-only routes: responds
 * `403 { error: 'forbidden' }` instead of rendering an HTML error page, so a
 * denied `fetch` call gets a real error payload instead of falling back to a
 * generic parse-failure message. See issue #451. Kept separate from
 * {@link requireAccessLevelJson} (the generalized JSON variant for the
 * `AccessLevel` ladder) since owner status is a global `isOwner` flag, not
 * a per-guild access level.
 * @param req - Express request; checked for `req.session.user?.isOwner`.
 * @param res - Express response; used to send a 403 JSON body when denied.
 * @param next - Called when the session user is the owner.
 * @returns Nothing; either calls `next()` or sends a 403 JSON response.
 */
export function requireOwnerJson(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user?.isOwner) {
    next();
  } else {
    res.status(403).json({ error: 'forbidden' });
  }
}
