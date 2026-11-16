import type { Response } from 'express';
import { createLogger } from '../../shared/logger';
import { reloadGuildRegistry } from '../../discord/guildRegistry';
import { runUserMutationForActorAndTarget } from '../../shared/userMutationQueue';

// Shared plumbing for the /admin/users member-mutation routes (adminUsersMutations.ts): running an
// authorization check and the write it guards together in the per-user mutation queue, and
// refreshing the guild registry after a membership change.

const log = createLogger('Web');

/** Refresh the guild registry after a membership change; log but never fail the request. */
export async function reloadRegistrySafe(): Promise<void> {
  try {
    await reloadGuildRegistry();
  } catch (err) {
    log.error('Guild registry reload after membership change failed:', err);
  }
}

/** One /admin/users mutation, as run by {@link runGuardedUserMutation}. */
export interface GuardedUserMutation {
  /**
   * The authorization check (`checkManagerEditAuth`, `checkRemoveAuth`, …): an `?error=` code
   * when the actor may not make this change, or null when they may.
   */
  authorize: () => Promise<string | null>;
  /** The write the check guards; may return an `?error=` code (e.g. `not_found`) instead of throwing. */
  write: () => Promise<string | null | void>;
  /** Called, and expected to redirect, when `authorize` or `write` throws. */
  onError: (err: unknown) => void;
}

/**
 * Runs `mutation.authorize` and then, if it allows the change, `mutation.write`, both inside one
 * `runUserMutationForActorAndTarget` slot for `actorId`/`targetId`, then redirects back to
 * `/admin/users`, carrying the error code either step returned.
 *
 * The check runs inside the queue, not before it, so it can't go stale against a write that lands
 * while this request waits for the slot (see `checkManagerEditAuth`'s doc comment). Serializing
 * against the actor's id as well as the target's matters because each check re-reads the *acting*
 * user's own access level; see `runUserMutationForActorAndTarget`'s doc comment.
 * @param res - Express response, used to redirect once the mutation has settled.
 * @param actorId - Discord snowflake of the acting user.
 * @param targetId - Discord snowflake of the user being changed.
 * @param mutation - The check, the write it guards, and the handler for a thrown error.
 * @returns Resolves once the redirect (or `mutation.onError`) has been issued.
 */
export async function runGuardedUserMutation(
  res: Response,
  actorId: string,
  targetId: string,
  mutation: GuardedUserMutation,
): Promise<void> {
  let errorCode: string | null;
  try {
    errorCode = await runUserMutationForActorAndTarget(actorId, targetId, async () =>
      (await mutation.authorize()) ?? (await mutation.write()) ?? null,
    );
  } catch (err) {
    mutation.onError(err);
    return;
  }
  res.redirect(errorCode ? `/admin/users?error=${errorCode}` : '/admin/users');
}
