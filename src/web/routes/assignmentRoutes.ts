import { Router } from 'express';
import type { Logger } from 'winston';
import { findUser } from '../../db';
import { csrfProtection } from '../csrf';
import { requireMod } from '../middleware';
import { normalizeDiscordId, logAndRedirectError } from './shared';

/** Options for {@link createAssignmentRouter}. */
export interface AssignmentRouterOptions<TId> {
  /** Path the assign/unassign routes live under, and the redirect target on success/error (e.g. `/commands`, `/timers`). */
  basePath: string;
  /** Form field name carrying the entity id (e.g. `command_id`, `timer_id`). */
  idField: string;
  /** Parses/validates the raw id field into `TId`, or null if malformed. */
  parseId: (raw: string) => TId | null;
  /** Assigns `discordId` to the entity. May throw — see {@link mapAssignError}. */
  assign: (id: TId, discordId: string) => Promise<void>;
  /** Removes `discordId`'s assignment from the entity. */
  unassign: (id: TId, discordId: string) => Promise<void>;
  /**
   * Maps an error thrown by `assign` to a specific error code, or null to fall through to the
   * generic `assign_failed` redirect. Lets a caller special-case its own error types (e.g.
   * Commands' trigger-conflict errors) without other callers carrying logic they don't need.
   */
  mapAssignError?: (err: unknown) => string | null;
  /** Logger to record unexpected errors on. */
  log: Logger;
}

/**
 * Builds a `POST {basePath}/assign` / `POST {basePath}/unassign` router pair: assigns or removes
 * a Twitch-linked Discord user's association with an entity (a custom command, a timer command,
 * ...). Both routes are gated `requireMod` + `csrfProtection`. Shared by `commandAssignments.ts`
 * and `timerAssignments.ts`, which previously duplicated this same shape end to end.
 * @param options - See {@link AssignmentRouterOptions}.
 */
export function createAssignmentRouter<TId>(options: AssignmentRouterOptions<TId>): Router {
  const { basePath, idField, parseId, assign, unassign, mapAssignError, log } = options;
  const router = Router();

  /**
   * POST `{basePath}/assign` — assigns a Twitch-linked Discord user to the entity identified by
   * `idField`.
   * @param req - Express request; reads `idField` and `discord_id` from `req.body`.
   * @param res - Express response; redirects to `basePath` on success, or to
   *   `basePath?error=<code>` if fields are missing (`missing_fields`), IDs are malformed
   *   (`invalid_id`), the user doesn't exist or has no linked Twitch name
   *   (`invalid_assignment_user`), `mapAssignError` maps a thrown error to a specific code, or
   *   the assignment write fails for any other reason (`assign_failed`).
   */
  router.post(`${basePath}/assign`, requireMod, csrfProtection, async (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const rawId = body[idField];
    const discordId = body.discord_id;
    if (!rawId || !discordId) {
      return res.redirect(`${basePath}?error=missing_fields`);
    }

    const id = parseId(rawId);
    const normalizedDiscordId = normalizeDiscordId(discordId);

    if (id === null || normalizedDiscordId === null) {
      return res.redirect(`${basePath}?error=invalid_id`);
    }

    try {
      const user = await findUser(normalizedDiscordId);
      if (!user || !user.twitch_name) {
        return res.redirect(`${basePath}?error=invalid_assignment_user`);
      }

      await assign(id, normalizedDiscordId);
    } catch (err) {
      const mappedErrorCode = mapAssignError?.(err);
      if (mappedErrorCode) {
        return res.redirect(`${basePath}?error=${mappedErrorCode}`);
      }

      return logAndRedirectError({
        res, log, logLabel: `Assign user error (${basePath}):`, err, basePath, errorCode: 'assign_failed',
      });
    }

    res.redirect(basePath);
  });

  /**
   * POST `{basePath}/unassign` — removes a user's assignment from the entity identified by `idField`.
   * @param req - Express request; reads `idField` and `discord_id` from `req.body`.
   * @param res - Express response; redirects to `basePath` on success, or to
   *   `basePath?error=<code>` if fields are missing (`missing_fields`), IDs are malformed
   *   (`invalid_id`), or the unassign write fails (`unassign_failed`).
   */
  router.post(`${basePath}/unassign`, requireMod, csrfProtection, async (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const rawId = body[idField];
    const discordId = body.discord_id;
    if (!rawId || !discordId) {
      return res.redirect(`${basePath}?error=missing_fields`);
    }

    const id = parseId(rawId);
    const normalizedDiscordId = normalizeDiscordId(discordId);

    if (id === null || normalizedDiscordId === null) {
      return res.redirect(`${basePath}?error=invalid_id`);
    }

    try {
      await unassign(id, normalizedDiscordId);
    } catch (err) {
      return logAndRedirectError({
        res, log, logLabel: `Unassign user error (${basePath}):`, err, basePath, errorCode: 'unassign_failed',
      });
    }

    res.redirect(basePath);
  });

  return router;
}
