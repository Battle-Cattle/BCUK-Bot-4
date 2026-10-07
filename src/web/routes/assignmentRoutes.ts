import { Router, type Request, type Response } from 'express';
import type { Logger } from 'winston';
import { findUser, getMemberAccessLevel } from '../../db';
import { csrfProtection } from '../csrf';
import { requireGuildContext, requireMod } from '../middleware';
import { getCurrentGuildId } from '../session';
import { normalizeDiscordId } from './validation';
import { logAndRedirectError } from './errorHandling';
import { canManageCatalog } from './selfServiceAccess';

/** Options for {@link createAssignmentRouter}. */
export interface AssignmentRouterOptions<TId> {
  /** Path the assign/unassign routes live under, and the redirect target on success/error (e.g. `/commands`, `/timers`). */
  basePath: string;
  /** Form field name carrying the entity id (e.g. `command_id`, `timer_id`). */
  idField: string;
  /** Parses/validates the raw id field into `TId`, or null if malformed. */
  parseId: (raw: string) => TId | null;
  /** Assigns `discordId` to the entity. May throw — see {@link AssignmentRouterOptions.mapAssignError}. */
  assign: (id: TId, discordId: string) => Promise<void>;
  /** Removes `discordId`'s assignment from the entity. */
  unassign: (id: TId, discordId: string) => Promise<void>;
  /**
   * Maps an error thrown by `assign` to a specific error code, or null to fall through to the
   * generic `assign_failed` redirect. Lets a caller special-case its own error types (e.g.
   * Commands' trigger-conflict errors) without other callers carrying logic they don't need.
   */
  mapAssignError?: (err: unknown) => string | null;
  /**
   * When true, users below Mod may use the unassign route to remove *themselves* (their own
   * `discord_id`) from an entity — e.g. a streamer dropping a shared command from their own
   * channel. Removing anyone else still needs Mod+. Assign is always Mod+. Defaults to false.
   */
  allowSelfUnassign?: boolean;
  /** Logger to record unexpected errors on. */
  log: Logger;
}

/** The `idField`/`discord_id` pair read from an assign/unassign request body, once both are confirmed present. */
interface AssignmentRequestFields {
  rawId: string;
  discordId: string;
}

/** Reads and presence-checks `idField`/`discord_id` from `req.body`, or null if either is missing. */
function readAssignmentFields(req: Request, idField: string): AssignmentRequestFields | null {
  const body = req.body as Record<string, string | undefined>;
  const rawId = body[idField];
  const discordId = body.discord_id;
  return rawId && discordId ? { rawId, discordId } : null;
}

/**
 * POST `{basePath}/assign` handler — assigns a Twitch-linked Discord user who is a member of the
 * session's current guild to the entity identified by `idField`.
 * @param req - Express request; reads `idField` and `discord_id` from `req.body`.
 * @param res - Express response; redirects to `basePath` on success, or to
 *   `basePath?error=<code>` if fields are missing (`missing_fields`), IDs are malformed
 *   (`invalid_id`), the user doesn't exist or has no linked Twitch name
 *   (`invalid_assignment_user`), the user isn't a member of the current guild
 *   (`assignee_not_in_guild`), `mapAssignError` maps a thrown error to a specific code, or the
 *   assignment write fails for any other reason (`assign_failed`).
 * @param options - See {@link AssignmentRouterOptions}.
 */
async function handleAssign<TId>(req: Request, res: Response, options: AssignmentRouterOptions<TId>): Promise<void> {
  const { basePath, assign, mapAssignError, log } = options;

  const target = parseAssignTarget(req, options);
  if ('error' in target) {
    res.redirect(`${basePath}?error=${target.error}`);
    return;
  }

  let errorCode: string | null;
  try {
    errorCode = await checkAssignee(req, target.discordId);
    if (!errorCode) await assign(target.id, target.discordId);
  } catch (err) {
    // A mapped error is an expected condition (e.g. a trigger conflict) — not a bug, so it isn't
    // logged as an error, matching the pre-refactor behavior for Commands' conflict redirects.
    errorCode = mapAssignError?.(err) ?? null;
    if (!errorCode) {
      logAndRedirectError({
        res, log, logLabel: `Assign user error (${basePath}):`, err, basePath, errorCode: 'assign_failed',
      });
      return;
    }
  }

  res.redirect(errorCode ? `${basePath}?error=${errorCode}` : basePath);
}

/**
 * Reads and parses the assign form's entity id and Discord id.
 * @param req - Express request; reads `idField` and `discord_id` from `req.body`.
 * @param options - Supplies `idField` and `parseId`; see {@link AssignmentRouterOptions}.
 * @returns The parsed ids, or `{ error }` with `missing_fields` or `invalid_id`.
 */
function parseAssignTarget<TId>(
  req: Request,
  options: AssignmentRouterOptions<TId>,
): { id: TId; discordId: string } | { error: string } {
  const fields = readAssignmentFields(req, options.idField);
  if (!fields) return { error: 'missing_fields' };
  const id = options.parseId(fields.rawId);
  const discordId = normalizeDiscordId(fields.discordId);
  if (id === null || discordId === null) return { error: 'invalid_id' };
  return { id, discordId };
}

/**
 * Checks that `discordId` may be assigned: the user exists, has a linked Twitch name, and is a
 * member of the session's current guild (a Mod may only assign members of the guild they're
 * managing, not streamers elsewhere).
 * @param req - Express request; the current guild comes from the session.
 * @param discordId - Normalized Discord ID of the user to assign.
 * @returns null if assignable, otherwise `invalid_assignment_user` or `assignee_not_in_guild`.
 */
async function checkAssignee(req: Request, discordId: string): Promise<string | null> {
  const user = await findUser(discordId);
  if (!user || !user.twitch_name) return 'invalid_assignment_user';
  if (await getMemberAccessLevel(getCurrentGuildId(req), discordId) === null) return 'assignee_not_in_guild';
  return null;
}

/**
 * Whether the session user may unassign `discordId`: Mod+ may unassign anyone, everyone else only
 * themselves. Assumes `requireGuildContext` has refreshed the session's access level.
 * @param req - Express request; reads `req.session.user`.
 * @param discordId - Normalized Discord ID being unassigned.
 * @returns True when the unassign is allowed.
 */
function isModOrSelf(req: Request, discordId: string): boolean {
  return canManageCatalog(req) || req.session.user?.discordId === discordId;
}

/**
 * POST `{basePath}/unassign` handler — removes a user's assignment from the entity identified by
 * `idField`.
 * @param req - Express request; reads `idField` and `discord_id` from `req.body`.
 * @param res - Express response; redirects to `basePath` on success, or to
 *   `basePath?error=<code>` if fields are missing (`missing_fields`), IDs are malformed
 *   (`invalid_id`), a user below Mod tries to unassign someone other than themselves
 *   (`forbidden`, only reachable with `allowSelfUnassign`), or the unassign write fails
 *   (`unassign_failed`).
 * @param options - See {@link AssignmentRouterOptions}.
 */
async function handleUnassign<TId>(req: Request, res: Response, options: AssignmentRouterOptions<TId>): Promise<void> {
  const { basePath, idField, parseId, unassign, allowSelfUnassign, log } = options;

  const fields = readAssignmentFields(req, idField);
  if (!fields) {
    res.redirect(`${basePath}?error=missing_fields`);
    return;
  }

  const id = parseId(fields.rawId);
  const normalizedDiscordId = normalizeDiscordId(fields.discordId);
  if (id === null || normalizedDiscordId === null) {
    res.redirect(`${basePath}?error=invalid_id`);
    return;
  }

  // Without allowSelfUnassign the route is already requireMod-gated, so only check here with it.
  if (allowSelfUnassign && !isModOrSelf(req, normalizedDiscordId)) {
    res.redirect(`${basePath}?error=forbidden`);
    return;
  }

  try {
    await unassign(id, normalizedDiscordId);
  } catch (err) {
    logAndRedirectError({
      res, log, logLabel: `Unassign user error (${basePath}):`, err, basePath, errorCode: 'unassign_failed',
    });
    return;
  }

  res.redirect(basePath);
}

/**
 * Builds a `POST {basePath}/assign` / `POST {basePath}/unassign` router pair: assigns or removes
 * a Twitch-linked Discord user's association with an entity (a custom command, a timer command,
 * ...). Both routes are gated `requireGuildContext` + `requireMod` + `csrfProtection`, except that
 * with `allowSelfUnassign` the unassign route drops `requireMod` and instead lets users below Mod
 * remove only themselves. Shared by `commandAssignments.ts` and `timerAssignments.ts`, which
 * previously duplicated this same shape end to end.
 * @param options - See {@link AssignmentRouterOptions}.
 */
export function createAssignmentRouter<TId>(options: AssignmentRouterOptions<TId>): Router {
  const router = Router();
  const unassignGate = options.allowSelfUnassign ? [requireGuildContext] : [requireGuildContext, requireMod];
  router.post(`${options.basePath}/assign`, requireGuildContext, requireMod, csrfProtection, (req, res) => handleAssign(req, res, options));
  router.post(`${options.basePath}/unassign`, ...unassignGate, csrfProtection, (req, res) => handleUnassign(req, res, options));
  return router;
}
