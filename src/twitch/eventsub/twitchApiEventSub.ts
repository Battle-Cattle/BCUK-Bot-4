import { createLogger } from '../../shared/logger';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from '../../shared/config';
import { twitchFetch, authHeaders } from '../twitchApi';
import type { DbStreamerEventSub } from '../../db';
import { saveStreamerToken, clearStreamerToken } from '../../db';

const log = createLogger('TwitchToken');
const TOKEN_BUFFER_MS = 5 * 60 * 1000;

export async function getValidToken(streamer: DbStreamerEventSub): Promise<string | null> {
  if (!streamer.eventsub_access_token) return null;
  // eventsub_token_expiry is BIGINT epoch ms — safe to coerce, won't exceed MAX_SAFE_INTEGER until year 275760.
  const needsRefresh = streamer.eventsub_token_expiry != null
    && Date.now() > Number(streamer.eventsub_token_expiry) - TOKEN_BUFFER_MS;
  if (!needsRefresh) return streamer.eventsub_access_token;
  if (!streamer.eventsub_refresh_token) {
    log.warn(`No refresh token for ${streamer.twitch_name ?? 'unknown'}`);
    return null;
  }
  try {
    const tokens = await refreshUserToken(streamer.eventsub_refresh_token);
    const expiryMs = tokens.expires_in != null ? Date.now() + tokens.expires_in * 1000 - 60_000 : null;
    await saveStreamerToken(streamer.id, streamer.twitch_user_id!, tokens.access_token, tokens.refresh_token, expiryMs);
    log.info(`Token refreshed for ${streamer.twitch_name ?? 'unknown'}`);
    return tokens.access_token;
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      await clearStreamerToken(streamer.id);
      log.error(`Token refresh failed for ${streamer.twitch_name ?? 'unknown'} — re-authorization required:`, err);
    } else {
      log.error(`Token refresh failed for ${streamer.twitch_name ?? 'unknown'} — transient error, will retry on next reload:`, err);
    }
    return null;
  }
}

/** Thrown when Twitch returns 400/401 — indicates invalid or expired credentials that require re-authorization. */
export class TwitchAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitchAuthError';
  }
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/**
 * POSTs a form-encoded request to Twitch's OAuth token endpoint and returns the parsed tokens.
 * Shared by `exchangeCode` and `refreshUserToken`, which only differ in the grant-type-specific
 * params they send — `client_id`/`client_secret` are added here for both.
 * @param grantParams - Grant-type-specific form params (e.g. `code`/`redirect_uri`, or `refresh_token`).
 * @param label - Human-readable label used in the thrown error message on failure.
 * @returns The parsed OAuth tokens.
 * @throws {TwitchAuthError} If Twitch returns 400 or 401 (invalid/expired code or refresh token).
 * @throws If Twitch returns any other non-OK status.
 */
async function postTokenRequest(grantParams: Record<string, string>, label: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    ...grantParams,
  });
  const res = await twitchFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.status === 400 || res.status === 401) throw new TwitchAuthError(`[TwitchAPI] ${label}: invalid/expired credentials (${res.status})`);
  if (!res.ok) throw new Error(`[TwitchAPI] ${label} failed: ${res.status}`);
  return res.json() as Promise<OAuthTokens>;
}

/**
 * Exchanges an authorization code from Twitch's OAuth redirect for an access/refresh token pair.
 * @param code - Authorization code received from Twitch's OAuth redirect.
 * @param redirectUri - The exact redirect URI used in the authorization request (must match).
 * @returns The issued OAuth tokens.
 * @throws {TwitchAuthError} If Twitch returns 400 or 401 (invalid/expired code).
 * @throws If Twitch returns any other non-OK status.
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  return postTokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri }, 'exchangeCode');
}

/**
 * Exchanges a stored refresh token for a fresh access/refresh token pair.
 * @param refreshToken - The previously-issued refresh token.
 * @returns The refreshed OAuth tokens.
 * @throws {TwitchAuthError} If Twitch returns 400 or 401 (invalid/expired refresh token).
 * @throws If Twitch returns any other non-OK status.
 */
export async function refreshUserToken(refreshToken: string): Promise<OAuthTokens> {
  return postTokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'refreshUserToken');
}

/** Validates a user access token and returns the owning user's ID and login, or null if invalid. */
export async function getUserFromToken(accessToken: string): Promise<{ id: string; login: string } | null> {
  const res = await twitchFetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (res.status === 401 || res.status === 400) return null;
  if (!res.ok) throw new Error(`[TwitchAPI] getUserFromToken failed: ${res.status}`);
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
  if (res.status === 401 || res.status === 403) {
    const errBody = await res.text().catch(() => '');
    throw new TwitchAuthError(`[TwitchAPI] createEventSubSubscription (${type}) failed: ${res.status} ${errBody}`);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`[TwitchAPI] createEventSubSubscription (${type}) failed: ${res.status} ${errBody}`);
  }
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
