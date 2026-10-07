// Helix EventSub subscription calls (create/list/delete). Token handling lives in
// `twitch/twitchUserTokens.ts`.
import { twitchFetch, authHeaders } from '../twitchApi';
import { TwitchAuthError } from '../twitchUserTokens';

/** Creates an EventSub subscription via WebSocket transport. Returns the subscription ID,
 *  or null if the subscription already exists (409). Throws on other failures. */
export async function createEventSubSubscription(
  type: string,
  version: string,
  condition: Record<string, string>,
  sessionId: string,
  token: string,
): Promise<string | null> {
  const res = await twitchFetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      version,
      condition,
      transport: { method: 'websocket', session_id: sessionId },
    }),
  });
  if (res.status === 409) return null;
  if (res.status === 401 || res.status === 403) {
    const errBody = await res.text().catch(() => '');
    throw new TwitchAuthError(`[TwitchAPI] createEventSubSubscription (${type}) failed: ${res.status} ${errBody}`);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`[TwitchAPI] createEventSubSubscription (${type}) failed: ${res.status} ${errBody}`);
  }
  const data = await res.json() as { data: Array<{ id: string }> };
  const subscription = Array.isArray(data.data) ? data.data[0] : undefined;
  if (!subscription) {
    throw new Error(`[TwitchAPI] createEventSubSubscription (${type}) returned empty data`);
  }
  return subscription.id;
}

/** Lists EventSub subscriptions. With a user token returns the broadcaster's subscriptions —
 *  note this also includes any subscription where the token's user is a *moderator* in the
 *  condition (e.g. `channel.follow`'s `moderator_user_id`), so the result can include another
 *  broadcaster's subscription entirely; callers must match on `condition`, not just `type`, to
 *  avoid acting on a subscription that isn't actually theirs. With an app token and userId
 *  returns subscriptions matching that user in any condition.
 *  `sessionId` is the WebSocket session (if any) the subscription is currently bound to — used
 *  to tell a subscription still live on the current connection apart from a stale duplicate
 *  left over from a prior (possibly dead) session. `status` is Twitch's own subscription state
 *  (e.g. `enabled`, `authorization_revoked`, `notification_failures_exceeded`) — a subscription
 *  bound to the live session isn't necessarily receiving notifications; callers must check
 *  `status === 'enabled'` before treating it as such. */
export async function listEventSubSubscriptions(
  token: string,
  userId?: string,
): Promise<Array<{ id: string; type: string; condition: Record<string, string>; sessionId?: string; status?: string }>> {
  const url = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
  if (userId) url.searchParams.set('user_id', userId);
  const results: Array<{ id: string; type: string; condition: Record<string, string>; sessionId?: string; status?: string }> = [];
  let cursor: string | undefined;
  do {
    if (cursor) url.searchParams.set('after', cursor);
    const res = await twitchFetch(url.toString(), { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`[TwitchAPI] listEventSubSubscriptions failed: ${res.status}`);
    const data = await res.json() as {
      data: Array<{ id: string; type: string; condition: Record<string, string>; transport?: { session_id?: string }; status?: string }>;
      pagination?: { cursor?: string };
    };
    results.push(...data.data.map((sub) => (
      { id: sub.id, type: sub.type, condition: sub.condition, sessionId: sub.transport?.session_id, status: sub.status }
    )));
    cursor = data.pagination?.cursor;
  } while (cursor);
  return results;
}

/**
 * Deletes an EventSub subscription. A 404 (already gone) counts as success.
 * @param id - Subscription ID.
 * @param token - Access token authorised to manage the subscription.
 * @returns Resolves once the subscription is deleted or confirmed absent.
 * @throws On any other non-OK response.
 */
export async function deleteEventSubSubscription(id: string, token: string): Promise<void> {
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  if (res.ok || res.status === 404) return;
  throw new Error(`[TwitchAPI] deleteEventSubSubscription failed: ${res.status}`);
}
