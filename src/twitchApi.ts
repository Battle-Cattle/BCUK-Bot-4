import { createLogger } from './logger';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from './config';

const log = createLogger('TwitchAPI');

const FETCH_TIMEOUT_MS = 10_000;

function twitchFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

let cachedAppToken: string | null = null;
let appTokenExpiry = 0;
let tokenRefreshPromise: Promise<string> | null = null;

async function fetchNewAppToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const res = await twitchFetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`[TwitchAPI] Token request failed: ${res.status}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAppToken = data.access_token;
  // Expire 60 s early to avoid edge cases
  appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAppToken;
}

export async function getAppToken(): Promise<string> {
  if (cachedAppToken && Date.now() < appTokenExpiry) return cachedAppToken;
  if (!tokenRefreshPromise) {
    tokenRefreshPromise = fetchNewAppToken().finally(() => { tokenRefreshPromise = null; });
  }
  return tokenRefreshPromise;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Client-Id': TWITCH_CLIENT_ID,
  };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

const HELIX_MAX_RETRIES = 3;

async function fetchHelixWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  let res = await twitchFetch(url, { headers });

  for (let attempt = 1; attempt <= HELIX_MAX_RETRIES && res.status === 429; attempt++) {
    const resetHeader = res.headers.get('ratelimit-reset');
    const parsedReset = resetHeader ? Number(resetHeader) : NaN;
    const resetAt = Number.isFinite(parsedReset) ? parsedReset * 1000 : Date.now() + 5_000;
    const wait = Math.max(0, resetAt - Date.now());
    log.warn(`Rate limited (attempt ${attempt}/${HELIX_MAX_RETRIES}). Retrying after ${wait}ms`);
    await new Promise<void>((r) => setTimeout(r, wait));
    res = await twitchFetch(url, { headers });
  }

  return res;
}

export interface TwitchUser {
  login: string;
  id: string;
}

export async function getUsers(logins: string[]): Promise<TwitchUser[]> {
  if (logins.length === 0) return [];
  const token = await getAppToken();
  const results: TwitchUser[] = [];
  for (const batch of chunks(logins, 100)) {
    const params = batch.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    const res = await fetchHelixWithRetry(`https://api.twitch.tv/helix/users?${params}`, authHeaders(token));
    if (!res.ok) {
      // Clear the cached token on 401 so the next call re-fetches rather than
      // reusing an invalidated token until appTokenExpiry.
      if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
      throw new Error(`[TwitchAPI] getUsers failed: ${res.status}`);
    }
    const data = await res.json() as { data: Array<{ login: string; id: string }> };
    results.push(...data.data.map((u) => ({ login: u.login, id: u.id })));
  }
  return results;
}

export interface TwitchStream {
  user_id: string;
  user_login: string;
  game_name: string;
  title: string;
  thumbnail_url: string;
  /** 'live' when streaming, '' when not */
  type: string;
}

export async function getStreams(userIds: string[]): Promise<TwitchStream[]> {
  if (userIds.length === 0) return [];
  const token = await getAppToken();
  const results: TwitchStream[] = [];
  for (const batch of chunks(userIds, 100)) {
    const params = batch.map((id) => `user_id=${encodeURIComponent(id)}`).join('&');
    const res = await fetchHelixWithRetry(`https://api.twitch.tv/helix/streams?${params}&first=100`, authHeaders(token));
    if (!res.ok) {
      if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
      throw new Error(`[TwitchAPI] getStreams failed: ${res.status}`);
    }
    const data = await res.json() as { data: TwitchStream[] };
    results.push(...data.data);
  }
  return results;
}

export interface TwitchChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  game_name: string;
  title: string;
}

export async function getChannelInfo(broadcasterIds: string[]): Promise<TwitchChannelInfo[]> {
  if (broadcasterIds.length === 0) return [];
  const token = await getAppToken();
  const results: TwitchChannelInfo[] = [];
  for (const batch of chunks(broadcasterIds, 100)) {
    const params = batch.map((id) => `broadcaster_id=${encodeURIComponent(id)}`).join('&');
    const res = await fetchHelixWithRetry(`https://api.twitch.tv/helix/channels?${params}`, authHeaders(token));
    if (!res.ok) {
      if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
      throw new Error(`[TwitchAPI] getChannelInfo failed: ${res.status}`);
    }
    const data = await res.json() as { data: TwitchChannelInfo[] };
    results.push(...data.data);
  }
  return results;
}

export interface SharedChatParticipant {
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
}

export interface SharedChatSession {
  session_id: string;
  host_broadcaster_id: string;
  host_broadcaster_login: string;
  host_broadcaster_name: string;
  participants: SharedChatParticipant[];
  created_at: string;
  updated_at: string;
}

/**
 * Returns the active shared chat session for a broadcaster, or null if none exists.
 * A 403 response is treated as null — app tokens may lack the required channel scope
 * for some broadcasters; the caller falls back to no dedup in that case.
 */
export async function getSharedChatSession(broadcasterId: string): Promise<SharedChatSession | null> {
  const token = await getAppToken();
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/shared_chat/session?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) {
    if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
    throw new Error(`[TwitchAPI] getSharedChatSession failed: ${res.status}`);
  }
  const data = await res.json() as { data: SharedChatSession[] };
  return data.data[0] ?? null;
}

// ─── User OAuth helpers ───────────────────────────────────────────────────────

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
