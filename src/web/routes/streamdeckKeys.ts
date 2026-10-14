import { createLogger } from '../../shared/logger';
import { Router, type Request, type Response } from 'express';
import {
  hasApiKey,
  createApiKeyAndRequestGuildAccess,
  requestGuildAccessForExistingKey,
  rotateApiKey,
  getApiKeyVersion,
  keyVersionFromPlaintext,
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
import { getSessionUser, getCurrentGuildId } from '../session';
import { normalizeDiscordId, filterQueryParam } from './validation';
import { renderError, renderView } from './viewHelpers';
import { logAndRedirectError } from './errorHandling';
import { runUserMutation } from '../../shared/userMutationQueue';

const log = createLogger('Web');
const router = Router();

/** What the key status page shows: the guild's status row, a key to display once, and an error banner. */
interface KeyStatusView {
  /** The current (possibly just-created/rotated) guild-status row, or null. */
  keyRow: StreamdeckKeyGuildStatusRow | null;
  /** Freshly generated plaintext key to display once, or null if none. */
  newKey: string | null;
  /** Marker for the user's current key (see `keyVersionFromHash`), embedded in the rotate form. */
  keyVersion: string | null;
  /** Known `error` query-param code to show a banner for, or null. */
  error?: string | null;
}

/**
 * Renders the current user's Streamdeck key status page, shared by
 * GET /streamdeck-key and the success paths of the request/rotate POST
 * handlers below. Sent with `Cache-Control: no-store`, since it can carry a
 * plaintext key that must not be kept in the browser's (or any proxy's) cache.
 * @param req - Express request; reads `req.session.user` and `req.csrfToken()`.
 * @param res - Express response.
 * @param view - The status row, one-time key, key marker and error banner to render.
 */
function renderKeyStatus(req: Request, res: Response, view: KeyStatusView): void {
  res.set('Cache-Control', 'no-store');
  renderView(res, 'streamdeck-keys', {
    user: req.session.user,
    csrfToken: req.csrfToken(),
    keyRow: view.keyRow,
    newKey: view.newKey,
    keyVersion: view.keyVersion,
    error: view.error ?? null,
  });
}

/** This guild's earlier request was denied by an Admin, so the user can't re-request it. */
class RequestDeniedError extends Error {}

/** The rotate form was rendered for a key that has since been replaced (e.g. a resubmitted form). */
class KeyAlreadyRotatedError extends Error {}

// ─── User routes (any authenticated user) ────────────────────────────────────

const USER_KNOWN_ERRORS = new Set(['request_failed', 'request_denied', 'rotate_failed', 'already_rotated', 'revoke_failed']);

/**
 * Renders the current user's Streamdeck API key status page for their current guild.
 * @param req - Express request; reads `req.session.user` and `req.query.error`.
 * @param res - Express response; renders the `streamdeck-keys` view, or a 500 error page on failure.
 * @returns A promise that resolves once the view (or error page) has been rendered.
 */
router.get('/streamdeck-key', csrfProtection, async (req, res) => {
  try {
    const discordId = getSessionUser(req).discordId;
    const [keyRow, keyVersion] = await Promise.all([
      getGuildStatusForKey(discordId, getCurrentGuildId(req)),
      getApiKeyVersion(discordId),
    ]);
    renderKeyStatus(req, res, { keyRow, newKey: null, keyVersion, error: filterQueryParam(req.query.error, USER_KNOWN_ERRORS) });
  } catch (err) {
    log.error('Streamdeck key page error:', err);
    renderError(res, 500, 'Failed to load Streamdeck key status.', req.session.user);
  }
});

interface RecentRotation {
  plain: string;
  rotatedAt: number;
}

// Tracks a just-completed rotation per discordId (not per guild — the key
// secret itself is global to the user, only its per-guild approval status
// differs) for a short window, so a rapid duplicate POST (rotate, or a
// re-request after a revoke, which also rotates) reuses the plaintext already
// rendered instead of rotating again and silently invalidating the key the
// user was just shown. Keying this by discordId alone (rather than also
// guildId) matters: a user switching between two guilds they belong to and
// clicking "Lost your key?" in each within the window must get back the
// *same* key, not a second, silently-invalidating rotation — the guild's
// approval status is always read fresh per request instead, so it's never
// served stale across guilds. Entries both expire lazily by age (like the rest
// of this codebase's TTL caches) and are actively evicted via a guarded timer
// once expired, so a plaintext key never lingers in process memory longer
// than the dedupe window. A resubmission *after* the window is caught by the
// rotate form's key marker instead (see `POST /streamdeck-key/rotate`).
const ROTATE_DEDUPE_WINDOW_MS = 10_000;
const recentRotations = new Map<string, RecentRotation>();

/** Test-only: clears the rotate dedupe cache so each test starts from a clean slate. */
export function __resetRecentRotationsForTests(): void {
  recentRotations.clear();
}

/**
 * The plaintext of this user's rotation within the dedupe window, if there was one.
 * @param discordId - Key owner's Discord snowflake.
 */
function recentRotationPlain(discordId: string): string | null {
  const recent = recentRotations.get(discordId);
  return recent && Date.now() - recent.rotatedAt < ROTATE_DEDUPE_WINDOW_MS ? recent.plain : null;
}

/**
 * Rotates the user's key and remembers the plaintext for the dedupe window. Call only inside
 * `runUserMutation` for this user.
 * @param discordId - Key owner's Discord snowflake; must already have a key.
 * @returns The new plaintext key.
 */
async function rotateAndRemember(discordId: string): Promise<string> {
  const { plain } = await rotateApiKey(discordId);
  const result: RecentRotation = { plain, rotatedAt: Date.now() };
  recentRotations.set(discordId, result);
  setTimeout(() => {
    if (recentRotations.get(discordId) === result) recentRotations.delete(discordId);
  }, ROTATE_DEDUPE_WINDOW_MS).unref();
  return plain;
}

/**
 * Applies a request for Streamdeck access in `guildId` and returns the plaintext key to show,
 * if any. Call only inside `runUserMutation` for this user.
 * - No key yet: mints one (shown once).
 * - Key from another guild, no row here: requests access with that key (no plaintext to show,
 *   since only its hash is stored).
 * - Revoked here: requests access again *and* rotates the key, so a key revoked because it
 *   leaked can't come back to life; the new key is shown.
 * - Pending/approved here: an idempotent no-op, so a duplicate submission never invalidates a
 *   key the user was just shown (it re-shows a rotation from the dedupe window, if any).
 * - Denied here: throws {@link RequestDeniedError}; only an Admin can reverse a denial.
 * @param discordId - Requesting user's Discord snowflake.
 * @param accessLevel - The user's access level in `guildId`, for auto-approval.
 * @param guildId - The guild to request access for.
 */
async function applyKeyRequest(discordId: string, accessLevel: number, guildId: string): Promise<string | null> {
  const existing = await getGuildStatusForKey(discordId, guildId);
  if (existing?.status === 'denied') {
    throw new RequestDeniedError('API key request rejected: previous request was denied');
  }
  if (existing?.status === 'revoked') {
    // Rotate first: if re-requesting then fails, this guild stays revoked and the old key is
    // already dead, rather than the old (possibly leaked) key being re-enabled unrotated.
    const plain = await rotateAndRemember(discordId);
    await requestGuildAccessForExistingKey(discordId, accessLevel, guildId);
    return plain;
  }
  if (existing) return recentRotationPlain(discordId);
  if (await hasApiKey(discordId)) {
    await requestGuildAccessForExistingKey(discordId, accessLevel, guildId);
    return null;
  }
  return (await createApiKeyAndRequestGuildAccess(discordId, accessLevel, guildId)).plain;
}

/**
 * Requests Streamdeck access for the current guild and renders the result (see
 * {@link applyKeyRequest} for each starting state). The check-then-act sequence is
 * serialized per `discordId` through `runUserMutation` — without it, two concurrent
 * requests from a brand-new user could both see "no existing key" and race on the
 * identity insert. Genuine key rotation (the "lost my key" flow) is a separate
 * explicit action — see `POST /streamdeck-key/rotate` below.
 *
 * @param req - Express request; reads `req.session.user` (discordId, accessLevel, currentGuildId).
 * @param res - Express response; renders the `streamdeck-keys` view with the new/existing key
 *   status on success, or redirects to `/streamdeck-key?error=request_denied` when this guild's
 *   request was denied, or `?error=request_failed` on any other failure.
 * @returns A promise that resolves once the view has been rendered or the error redirect issued.
 */
router.post('/streamdeck-key/request', csrfProtection, async (req, res) => {
  const { discordId, accessLevel } = getSessionUser(req);
  const guildId = getCurrentGuildId(req);
  try {
    const plain = await runUserMutation(discordId, () => applyKeyRequest(discordId, accessLevel, guildId));
    const [keyRow, keyVersion] = await Promise.all([
      getGuildStatusForKey(discordId, guildId),
      plain ? keyVersionFromPlaintext(plain) : getApiKeyVersion(discordId),
    ]);
    renderKeyStatus(req, res, { keyRow, newKey: plain, keyVersion });
  } catch (err) {
    const errorCode = err instanceof RequestDeniedError ? 'request_denied' : 'request_failed';
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key request error:', err, basePath: '/streamdeck-key', errorCode });
  }
});

/**
 * Rotates the user's key for `POST /streamdeck-key/rotate`, or returns the plaintext of a
 * rotation still in the dedupe window. Call only inside `runUserMutation` for this user.
 * @param discordId - Key owner's Discord snowflake.
 * @param submittedVersion - The key marker the rotate form was rendered with, or null if the
 *   form didn't carry one (e.g. a page cached from before markers existed).
 * @throws {KeyAlreadyRotatedError} when the form was rendered for a key that has since been
 *   replaced, so a resubmitted form can't rotate a second time.
 */
async function rotateForForm(discordId: string, submittedVersion: string | null): Promise<string> {
  const recent = recentRotationPlain(discordId);
  if (recent) return recent;
  if (!(await hasApiKey(discordId))) {
    throw new Error('Cannot rotate: no existing Streamdeck API key');
  }
  if (submittedVersion !== null && submittedVersion !== (await getApiKeyVersion(discordId))) {
    throw new KeyAlreadyRotatedError('Rotate form was for a key that has already been replaced');
  }
  return rotateAndRemember(discordId);
}

/**
 * Rotates the current user's existing Streamdeck API key secret — the
 * explicit "lost my key" action. Every guild's approval state is left
 * untouched; only the key's identity (hash) changes, so the old key
 * immediately stops working everywhere. Distinct from
 * `POST /streamdeck-key/request`, which never rotates a key that's already
 * pending or approved.
 *
 * The guild's approval status is read *before* the key is rotated, so a
 * transient failure of that read never strands an already-rotated (and now
 * unrecoverable — only the hash is ever stored) plaintext key behind a
 * "failed" response. Rotation itself is serialized per `discordId` through
 * `runUserMutation`. A rotation within `ROTATE_DEDUPE_WINDOW_MS` of the last
 * one for this user reuses that plaintext; after that, the form's `key_version`
 * marker stops a resubmitted form (refresh, Back then Forward) from rotating
 * again and invalidating the key it already showed.
 *
 * @param req - Express request; reads `req.session.user` and the form's `key_version`.
 * @param res - Express response; renders the `streamdeck-keys` view with the freshly
 *   rotated plaintext key on success, or redirects to `?error=already_rotated` for a stale
 *   form, or `?error=rotate_failed` if the user has no key yet, the status read fails, or
 *   rotation fails.
 * @returns A promise that resolves once the view has been rendered or the error redirect issued.
 */
router.post('/streamdeck-key/rotate', csrfProtection, async (req, res) => {
  const discordId = getSessionUser(req).discordId;
  const guildId = getCurrentGuildId(req);
  const rawVersion = (req.body as { key_version?: unknown } | undefined)?.key_version;
  const submittedVersion = typeof rawVersion === 'string' && rawVersion ? rawVersion : null;
  try {
    const keyRow = await getGuildStatusForKey(discordId, guildId);
    const plain = await runUserMutation(discordId, () => rotateForForm(discordId, submittedVersion));
    renderKeyStatus(req, res, { keyRow, newKey: plain, keyVersion: keyVersionFromPlaintext(plain) });
  } catch (err) {
    const errorCode = err instanceof KeyAlreadyRotatedError ? 'already_rotated' : 'rotate_failed';
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key rotate error:', err, basePath: '/streamdeck-key', errorCode });
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
    await revokeApiKey(getSessionUser(req).discordId, getCurrentGuildId(req));
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
    const guildId = getCurrentGuildId(req);
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
    await approveApiKey(validId, getSessionUser(req).discordId, getCurrentGuildId(req));
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
    await denyApiKey(validId, getCurrentGuildId(req));
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
    await revokeApiKey(validId, getCurrentGuildId(req));
    res.redirect('/admin/streamdeck-keys');
  } catch (err) {
    logAndRedirectError({ res, log, logLabel: 'Streamdeck key admin revoke error:', err, basePath: '/admin/streamdeck-keys', errorCode: 'revoke_failed' });
  }
});

export default router;
