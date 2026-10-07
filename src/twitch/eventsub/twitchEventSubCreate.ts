import { createHash } from 'node:crypto';
import { createLogger } from '../../shared/logger';
import { createEventSubSubscription, deleteEventSubSubscription } from './twitchApiEventSub';
import { TwitchAuthError } from '../twitchUserTokens';
import type { SubSpec } from './twitchEventSubSubscriptionGroups';

// Creating (or keeping) one EventSub subscription for one spec, and the auth-failure skip list
// that stops a token missing a scope from re-trying the same create every pass. Used by
// twitchEventSubSubscriptions.ts, which decides which specs a streamer wants.

const log = createLogger('EventSub');

// Tracks "login:type:tokenHash" triples that failed with 403 — skipped until bot restarts or
// token changes. Hashed rather than storing the raw access token: the key only needs to change
// when the token does (so a refreshed token naturally computes a different key and retries),
// not to retain the token's actual value in process memory for the (unbounded, until
// clearAuthFailedSubs runs) lifetime of this Set.
const authFailedSubs = new Set<string>();

/** Derives the skip-key's token component without retaining the raw access token. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Returns true if any subscription for the given login has previously failed with a 403. */
export function hasAuthFailedSubs(login: string): boolean {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) return true;
  return false;
}

/** Clears all auth-failed subscription records for the given login. */
export function clearAuthFailedSubs(login: string): void {
  const prefix = `${login}:`;
  for (const key of authFailedSubs) if (key.startsWith(prefix)) authFailedSubs.delete(key);
}

/** True if `a` and `b` describe the same condition, treating a missing key and an empty-string
 *  value as equal — Twitch's list response can echo a spec's unused optional condition keys back
 *  as `""` (e.g. `reward_id`, `from_broadcaster_user_id`), which must not stop an existing
 *  subscription from matching (the create would then 409 against it). Any key with a non-empty
 *  value on either side must match exactly, so a same-type subscription with a genuinely different
 *  condition (e.g. a leftover from an older API version whose condition shape has since changed)
 *  is still told apart from the one this spec wants. */
export function conditionsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? '') !== (b[key] ?? '')) return false;
  }
  return true;
}

/**
 * Ensures a single subscription type is live on the given session: keeps an existing
 * subscription that's already bound to `sessionId` *and* `enabled` — a subscription can be bound
 * to the live session yet not `enabled` (e.g. `authorization_revoked`, `notification_failures_exceeded`),
 * in which case it isn't actually receiving notifications and must not be counted as live — deletes
 * one that's stale (bound to a different session, or not enabled) before recreating it, or creates
 * fresh if none exists. Logs the deletion at WARN when it's still bound to the live session (a
 * genuine anomaly), or at INFO when it's bound to a different session (routine post-reconnect
 * cleanup — see {@link deleteStaleSubscriptions}).
 * @returns The create outcome (see {@link subscribe}; an existing live subscription counts as
 *   `live` with its id), and whether a stale `existing` subscription was actually deleted here — `false` on a failed delete
 *   attempt, so the caller knows not to treat that id as already gone (it must remain eligible for
 *   {@link deleteStaleSubscriptions} to retry in the same round).
 */
export async function ensureSubscription(
  sessionId: string, spec: SubSpec, token: string, name: string,
  existing: { id: string; sessionId?: string; status?: string } | undefined,
): Promise<{ result: SubscribeAttempt; deleted: boolean }> {
  if (existing && existing.sessionId === sessionId && existing.status === 'enabled') {
    return { result: { kind: 'live', id: existing.id }, deleted: false };
  }
  let deleted = false;
  if (existing) {
    if (existing.sessionId === sessionId) {
      // WARN: still bound to the *live* session yet not enabled (e.g. `authorization_revoked`,
      // `notification_failures_exceeded`) — a genuine anomaly, not something a reconnect explains.
      log.warn(`Deleting ${spec.type} subscription (${existing.id}) for ${name} — bound to the live session but not enabled (status=${existing.status})`);
    } else {
      // INFO, not WARN: every non-graceful reconnect (see forceReconnect in
      // twitchEventSubConnection.ts) starts a brand-new session, so *all* of the previous
      // session's subscriptions are legitimately "stale" here — this fires routinely on every
      // such reconnect, not just on an actual anomaly.
      log.info(`Deleting stale ${spec.type} subscription (${existing.id}) for ${name} — bound to a different session (status=${existing.status})`);
    }
    try {
      await deleteEventSubSubscription(existing.id, token);
      deleted = true;
    } catch (err) {
      log.error(`Failed to delete stale ${spec.type} subscription for ${name}:`, err);
    }
  }
  const result = await subscribe(sessionId, spec, token, name);
  return { result, deleted };
}

/** Result of one subscription create attempt: `live` (created — with its id — or already
 *  existing per a 409, with `id: null` since Twitch doesn't return it), `auth` (auth/scope failure,
 *  or skipped because this token+type already auth-failed), or `transient` (any other failure). */
export type SubscribeAttempt = { kind: 'live'; id: string | null } | { kind: 'auth' } | { kind: 'transient' };

/** Creates a single EventSub subscription and classifies the outcome (see {@link SubscribeAttempt}).
 *  A 409 Conflict (`createEventSubSubscription` returns null) means an identical subscription
 *  already exists, so it counts as live — but with no id, so {@link deleteStaleSubscriptions} won't
 *  prune other same-type subscriptions on its account (it can't tell which one is the live one).
 *  Callers use a non-null id to identify "the subscription created this round" when pruning. */
async function subscribe(sessionId: string, spec: SubSpec, token: string, login: string): Promise<SubscribeAttempt> {
  const skipKey = `${login}:${spec.type}:${hashToken(token)}`;
  if (authFailedSubs.has(skipKey)) return { kind: 'auth' };
  try {
    const id = await createEventSubSubscription(spec.type, spec.version, spec.condition, sessionId, token);
    authFailedSubs.delete(skipKey);
    if (id !== null) {
      log.info(`Subscribed to ${spec.type} for ${login}`);
    } else {
      log.info(`${spec.type} for ${login} already exists (409) — treating as live`);
    }
    return { kind: 'live', id };
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      authFailedSubs.add(skipKey);
      log.warn(`Skipping ${spec.type} for ${login} — authorization missing, user must reconnect Twitch`);
      return { kind: 'auth' };
    }
    log.error(`Failed to subscribe to ${spec.type} for ${login}:`, err);
    return { kind: 'transient' };
  }
}
