import type { Response } from 'express';
import { createLogger } from '../../shared/logger';
import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { runUserMutationForActorAndTarget } from '../../shared/userMutationQueue';
import { ManagerEditAuthError } from './adminUserAuth';

// Shared plumbing for the /admin/users member-mutation routes (adminUsersMutations.ts): running an
// auth-check-then-write in the per-user mutation queue, and refreshing the guild registry after it.

const log = createLogger('Web');

/** Refresh the guild registry after a membership change; log but never fail the request. */
export async function reloadRegistrySafe(): Promise<void> {
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Guild registry reload after membership change failed:', err);
  }
}

/**
 * Runs `operation` (typically a `checkManagerEditAuth`/`checkToggleTwitchAuth` check followed by
 * the write it guards) inside `runUserMutationForActorAndTarget` for `actorId`/`targetId`,
 * centralizing the `ManagerEditAuthError` → `?error=<code>` redirect shared by every queued
 * mutation route in `adminUsersMutations.ts` so it isn't repeated at each call site. Any other error is handled by
 * `onOtherError` instead.
 *
 * Serializing against both ids (not just `targetId`) matters here specifically because
 * `operation`'s authorization check re-reads the *acting* user's own current access level — see
 * `runUserMutationForActorAndTarget`'s doc comment for why a target-only lock still leaves that
 * read racing a concurrent demotion of the actor.
 *
 * Redirects to `/admin/users` itself on success, so callers don't need to repeat that redirect.
 * @param res - Express response, used to redirect on success or on a `ManagerEditAuthError`.
 * @param actorId - The acting user's discordId.
 * @param targetId - The user whose mutations `operation` should serialize against.
 * @param operation - The auth-check-then-write to run inside the queue.
 * @param onOtherError - Called (and expected to redirect) for any error other than
 *   `ManagerEditAuthError`.
 */
export async function runGuardedUserMutation(
  res: Response,
  actorId: string,
  targetId: string,
  operation: () => Promise<void>,
  onOtherError: (err: unknown) => void,
): Promise<void> {
  try {
    await runUserMutationForActorAndTarget(actorId, targetId, operation);
    res.redirect('/admin/users');
  } catch (err) {
    if (err instanceof ManagerEditAuthError) {
      res.redirect(`/admin/users?error=${err.code}`);
    } else {
      onOtherError(err);
    }
  }
}
