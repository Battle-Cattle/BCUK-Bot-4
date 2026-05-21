import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from './config';
import { twitchFetch, authHeaders } from './twitchApi';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await twitchFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`[TwitchAPI] exchangeCode failed: ${res.status}`);
  return res.json() as Promise<OAuthTokens>;
}

export async function refreshUserToken(refreshToken: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await twitchFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`[TwitchAPI] refreshUserToken failed: ${res.status}`);
  return res.json() as Promise<OAuthTokens>;
}

/** Validates a user access token and returns the owning user's ID and login, or null if invalid. */
export async function getUserFromToken(accessToken: string): Promise<{ id: string; login: string } | null> {
  const res = await twitchFetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { user_id: string; login: string };
  return { id: data.user_id, login: data.login };
}

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
  if (!res.ok) throw new Error(`[TwitchAPI] createEventSubSubscription (${type}) failed: ${res.status}`);
  const data = await res.json() as { data: Array<{ id: string }> };
  if (!Array.isArray(data.data) || data.data.length === 0) {
    throw new Error(`[TwitchAPI] createEventSubSubscription (${type}) returned empty data`);
  }
  return data.data[0].id;
}

/** Lists EventSub subscriptions. With a user token returns the broadcaster's subscriptions;
 *  with an app token and userId returns subscriptions matching that user in any condition. */
export async function listEventSubSubscriptions(
  token: string,
  userId?: string,
): Promise<Array<{ id: string; type: string }>> {
  const url = new URL('https://api.twitch.tv/helix/eventsub/subscriptions');
  if (userId) url.searchParams.set('user_id', userId);
  const results: Array<{ id: string; type: string }> = [];
  let cursor: string | undefined;
  do {
    if (cursor) url.searchParams.set('after', cursor);
    const res = await twitchFetch(url.toString(), { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`[TwitchAPI] listEventSubSubscriptions failed: ${res.status}`);
    const data = await res.json() as { data: Array<{ id: string; type: string }>; pagination?: { cursor?: string } };
    results.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);
  return results;
}

export async function deleteEventSubSubscription(id: string, token: string): Promise<void> {
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  if (res.ok || res.status === 404) return;
  throw new Error(`[TwitchAPI] deleteEventSubSubscription failed: ${res.status}`);
}
