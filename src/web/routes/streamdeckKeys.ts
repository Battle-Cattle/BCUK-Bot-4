import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import {
  hasApiKey,
  createApiKeyAndRequestGuildAccess,
  requestGuildAccessForExistingKey,
  rotateApiKey,
  getGuildStatusForKey,
  revokeApiKey,
  approveApiKey,
  denyApiKey,
  getAllApiKeys,
  getPendingRequests,
  type StreamdeckKeyGuildStatusRow,
} from '../../db';
import { csrfProtection } from '../csrf';
import { requireAdmin } from '../middleware';
import { WEB_PORT } from '../../shared/config';
import { logAndRedirectError, normalizeDiscordId, renderError, filterQueryParam, renderView } from './shared';
import { userMutationQueue } from './adminUserMutationQueue';

const log = createLogger('Web');
const router = Router();

/**
 * Renders the current user's Streamdeck key status page, shared by
 * GET /streamdeck-key and the success paths of the request/rotate POST
 * handlers below (they only differ in what `keyRow`/`newKey` they pass in).
 * @param req - Express request; reads `req.session.user` and `req.csrfToken()`.
 * @param res - Express response.
 * @param keyRow - The current (possibly just-created/rotated) guild-status row, or null.
 * @param newKey - Freshly generated plaintext key to display once, or null if none.
 */
function renderKeyStatus(
  req: Request,
  res: Response,
  keyRow: StreamdeckKeyGuildStatusRow | null,
  newKey: string | null,
): void {
  renderView(res, 'streamdeck-keys', {
    user: req.session.user,
    csrfToken: req.csrfToken(),
    keyRow,
    newKey,
    error: null,
    webPort: WEB_PORT,
  });
}

// ─── User routes (any authenticated user) ────────────────────────────────────

const USER_KNOWN_ERRORS = new Set(['request_failed', 'rotate_failed', 'revoke_failed']);

/**
 * Renders the current user's Streamdeck API key status page for their current guild.
 * @param req - Express request; reads `req.session.user` and `req.query.error`.
 * @param res - Express response; renders the `streamdeck-keys` view, or a 500 error page on failure.
 * @returns A promise that resolves once the view (or error page) has been rendered.
 */
router.get('/streamdeck-key', csrfProtection, async (req, res) => {
  try {
    const keyRow = await getGuildStatusForKey(req.session.user!.discordId, req.session.user!.currentGuildId!);
    renderView(res, 'streamdeck-keys', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      keyRow,
      newKey: null,
      error: filterQueryParam(req.query.error, USER_KNOWN_ERRORS),
      webPort: WEB_PORT,
    });
  } catch (err) {
    log.error('Streamdeck key page error:', err);
    renderError(res, 500, 'Failed to load Streamdeck key status.', req.session.user);
  }
});

/**
 * Requests Streamdeck access for the current guild and renders the result.
 * A brand-new user gets a freshly minted key (plaintext shown once). A user
 * who already has a key from another guild reuses it — no plaintext to show,
 * since only the key's hash is ever stored. A previously revoked request for
 * this guild is re-requested (routed back through the normal approval flow).
 *
 * Idempotent when this guild already has a pending/approved request on file —
 * it just re-renders the current status without touching the key, so an
 * accidental duplicate submission (double-click, browser retry, two requests
 * racing through `userMutationQueue`) never silently invalidates a plaintext
 * key the user was just shown. Genuine key rotation (the "lost my key" flow)
 * is a separate explicit action — see `POST /streamdeck-key/rotate` below.
 *
 * The check-then-act sequence below is serialized per `discordId` through
 * `userMutationQueue` — without it, two concurrent requests from a brand-new
 * user could both see "no existing key" and race on the identity insert.
 *
 * @param req - Express request; reads `req.session.user` (discordId, accessLevel, currentGuildId).
 * @param res - Express response; renders the `streamdeck-keys` view with the new/existing key
 *   status on success, or redirects to `/streamdeck-key?error=request_failed` on failure.
 * @returns A promise that resolves once the view has been rendered or the error redirect issued.
 */
router.post('/streamdeck-key/request', csrfProtection, async (req, res) => {
  const discordId = req.session.user!.discordId;
  const accessLevel = req.session.user!.accessLevel;
  const guildId = req.session.user!.currentGuildId!;
  try {
    const { plain, keyRow } = await userMutationQueue.run(discordId, async () => {
      const existingGuildStatus = await getGuildStatusForKey(discordId, guildId);
      let resolvedPlain: string | null = null;
      if (existingGuildStatus) {
        if (existingGuildStatus.status === 'denied') {
          throw new Error('API key request rejected: previous request was denied');
        }
        if (existingGuildStatus.status === 'revoked') {
          await requestGuildAccessForExistingKey(discordId, accessLevel, guildId);
        } else {
          // pending/approved: idempotent no-op — nothing changed, so the
          // status already fetched above is still current; skip re-querying it.
          return { plain: resolvedPlain, keyRow: existingGuildStatus };
        }
      } else if (await hasApiKey(discordId)) {
        await requestGuildAccessForExistingKey(discordId, accessLevel, guildId);
      } else {
        ({ plain: resolvedPlain } = await createApiKeyAndRequestGuildAccess(discordId, accessLevel, guildId));
      }
      return { plain: resolvedPlain, keyRow: await getGuildStatusForKey(discordId, guildId) };
    });
    renderKeyStatus(req, res, keyRow, plain);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key request error:', err, basePath: '/streamdeck-key', errorCode: 'request_failed' });
  }
});

interface RecentRotation {
  plain: string;
  keyRow: StreamdeckKeyGuildStatusRow | null;
  rotatedAt: number;
}

// Tracks a just-completed rotation per discordId for a short window so a
// rapid duplicate POST /streamdeck-key/rotate (a network-level retry of a
// timed-out request, or the same "Lost your key?" confirm landing twice from
// two tabs) reuses the response already rendered instead of rotating again
// and silently invalidating the key the user was just shown — the same class
// of accidental-duplicate bug this file's /request handler guards against.
// Entries are checked lazily by age (like the rest of this codebase's TTL
// caches) rather than actively evicted; bounded by the small, admin-managed
// user table this app already assumes elsewhere (see CLAUDE.md's user model).
const ROTATE_DEDUPE_WINDOW_MS = 10_000;
const recentRotations = new Map<string, RecentRotation>();

/** Test-only: clears the rotate dedupe cache so each test starts from a clean slate. */
export function __resetRecentRotationsForTests(): void {
  recentRotations.clear();
}

/**
 * Rotates the current user's existing Streamdeck API key secret — the
 * explicit "lost my key" action. Every guild's approval state is left
 * untouched; only the key's identity (hash) changes, so the old key
 * immediately stops working everywhere. Distinct from
 * `POST /streamdeck-key/request`, which never rotates a key that's already
 * pending or approved.
 *
 * Serialized per `discordId` through `userMutationQueue` for the same reason
 * as `/streamdeck-key/request` — to keep the has-a-key check and the
 * rotation itself atomic with respect to concurrent requests. A rotation
 * within `ROTATE_DEDUPE_WINDOW_MS` of the last one for this user reuses that
 * result instead of rotating again (see {@link recentRotations}).
 *
 * @param req - Express request; reads `req.session.user` (discordId, currentGuildId).
 * @param res - Express response; renders the `streamdeck-keys` view with the freshly
 *   rotated plaintext key on success, or redirects to
 *   `/streamdeck-key?error=rotate_failed` if the user has no key yet or rotation fails.
 * @returns A promise that resolves once the view has been rendered or the error redirect issued.
 */
router.post('/streamdeck-key/rotate', csrfProtection, async (req, res) => {
  const discordId = req.session.user!.discordId;
  const guildId = req.session.user!.currentGuildId!;
  try {
    const { plain, keyRow } = await userMutationQueue.run(discordId, async () => {
      const recent = recentRotations.get(discordId);
      if (recent && Date.now() - recent.rotatedAt < ROTATE_DEDUPE_WINDOW_MS) return recent;

      if (!(await hasApiKey(discordId))) {
        throw new Error('Cannot rotate: no existing Streamdeck API key');
      }
      // Independent reads/writes on unrelated tables (key hash vs. guild
      // approval status) — safe to run concurrently.
      const [{ plain: rotatedPlain }, rotatedKeyRow] = await Promise.all([
        rotateApiKey(discordId),
        getGuildStatusForKey(discordId, guildId),
      ]);
      const result: RecentRotation = { plain: rotatedPlain, keyRow: rotatedKeyRow, rotatedAt: Date.now() };
      recentRotations.set(discordId, result);
      return result;
    });
    renderKeyStatus(req, res, keyRow, plain);
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key rotate error:', err, basePath: '/streamdeck-key', errorCode: 'rotate_failed' });
  }
});

/**
 * Revokes the current user's own Streamdeck access for their current guild only — other guilds' approvals are unaffected.
 * @param req - Express request; reads `req.session.user` (discordId, currentGuildId).
 * @param res - Express response; redirects to `/streamdeck-key` on success, or
 *   `/streamdeck-key?error=revoke_failed` on failure.
 * @returns A promise that resolves once the redirect has been issued.
 */
router.post('/streamdeck-key/revoke', csrfProtection, async (req, res) => {
  try {
    await revokeApiKey(req.session.user!.discordId, req.session.user!.currentGuildId!);
    res.redirect('/streamdeck-key');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key revoke error:', err, basePath: '/streamdeck-key', errorCode: 'revoke_failed' });
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

const ADMIN_KNOWN_ERRORS = new Set(['approve_failed', 'deny_failed', 'revoke_failed', 'invalid_discord_id']);

/** Renders the admin Streamdeck key management page, listing pending and all key requests for the admin's current guild. */
router.get('/admin/streamdeck-keys', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const guildId = req.session.user!.currentGuildId!;
    const [pending, all] = await Promise.all([getPendingRequests(guildId), getAllApiKeys(guildId)]);
    renderView(res, 'streamdeck-keys-admin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      pending,
      all,
      error: filterQueryParam(req.query.error, ADMIN_KNOWN_ERRORS),
    });
  } catch (err) {
    log.error('Streamdeck admin keys error:', err);
    renderError(res, 500, 'Failed to load Streamdeck key management.', req.session.user);
  }
});

/** Approves a pending Streamdeck API key request for the Discord ID in the request body, scoped to the admin's current guild. */
router.post('/admin/streamdeck-keys/approve', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await approveApiKey(validId, req.session.user!.discordId, req.session.user!.currentGuildId!);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key approve error:', err, basePath: '/admin/streamdeck-keys', errorCode: 'approve_failed' });
  }
});

/** Denies a pending Streamdeck API key request for the Discord ID in the request body, scoped to the admin's current guild. */
router.post('/admin/streamdeck-keys/deny', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await denyApiKey(validId, req.session.user!.currentGuildId!);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key deny error:', err, basePath: '/admin/streamdeck-keys', errorCode: 'deny_failed' });
  }
});

/** Revokes the Streamdeck API key for the Discord ID in the request body, scoped to the admin's current guild. */
router.post('/admin/streamdeck-keys/revoke', requireAdmin, csrfProtection, async (req, res) => {
  const validId = normalizeDiscordId((req.body as { discord_id?: string }).discord_id);
  if (!validId) return res.redirect('/admin/streamdeck-keys?error=invalid_discord_id');
  try {
    await revokeApiKey(validId, req.session.user!.currentGuildId!);
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key admin revoke error:', err, basePath: '/admin/streamdeck-keys', errorCode: 'revoke_failed' });
  }
});

export default router;
