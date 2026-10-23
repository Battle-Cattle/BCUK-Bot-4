import { createLogger } from '../shared/logger';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from '../shared/config';
import { assertHelixOk } from './helixErrors';

const log = createLogger('TwitchAPI');

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches `url`, aborting if the request takes longer than {@link FETCH_TIMEOUT_MS}.
 * @param url URL to fetch.
 * @param init Standard `fetch` options; its `signal` (if any) is overridden by the timeout signal.
 * @returns The fetch response.
 */
export function twitchFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

let cachedAppToken: string | null = null;
let appTokenExpiry = 0;
let tokenRefreshPromise: Promise<string> | null = null;

/**
 * Requests a new app access token via the client-credentials flow and caches it, expiring
 * 60 s early to avoid using a token right at its expiry.
 * @returns The new access token.
 * @throws If the token request fails.
 */
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

  assertHelixOk(res, 'Token request');

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAppToken = data.access_token;
  // Expire 60 s early to avoid edge cases
  appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAppToken;
}

/**
 * Returns a valid Twitch app access token, reusing the cached one if it hasn't expired yet.
 * Concurrent calls during a refresh share the same in-flight request rather than each
 * triggering their own token fetch.
 * @returns A valid app access token.
 */
export async function getAppToken(): Promise<string> {
  if (cachedAppToken && Date.now() < appTokenExpiry) return cachedAppToken;
  if (!tokenRefreshPromise) {
    tokenRefreshPromise = fetchNewAppToken().finally(() => { tokenRefreshPromise = null; });
  }
  return tokenRefreshPromise;
}

/**
 * Builds the standard Twitch Helix authorization headers for `token`.
 * @param token Access token (app or user) to authenticate with.
 * @returns The `Authorization`/`Client-Id` headers to attach to a Helix request.
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Client-Id': TWITCH_CLIENT_ID,
  };
}

/**
 * Clears the cached app token on a 401 response, so the next call re-fetches rather than
 * reusing an invalidated token until `appTokenExpiry`. No-ops for any other status.
 * @param res - Helix response from an app-token-authenticated request.
 */
function invalidateAppTokenIfUnauthorized(res: Response): void {
  if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
}

/**
 * Throws {@link assertHelixOk}'s standard error for a non-OK app-token-authed Helix response,
 * first clearing the cached app token if the failure was a 401. Shared by
 * {@link fetchHelixPaged} and {@link getSharedChatSession} — the two callers that authenticate
 * with the app token (rather than a broadcaster user token) and so can hit an invalidated-token 401.
 * No-ops if `res.ok`.
 * @param res Helix response to check.
 * @param label Human-readable label used in the thrown error message.
 * @throws If `res` is not OK.
 */
function throwOnHelixError(res: Response, label: string): void {
  if (res.ok) return;
  invalidateAppTokenIfUnauthorized(res);
  assertHelixOk(res, label);
}

/**
 * Splits an array into consecutive chunks.
 * @param arr - The array to split.
 * @param size - Maximum chunk length; must be > 0.
 * @returns The chunks, in order.
 * @throws If `size` is not positive.
 */
function chunks<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunks: size must be > 0, got ${size}`);
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

const HELIX_MAX_RETRIES = 3;

const NETWORK_RETRY_DELAYS_MS = [2_000, 4_000];

/**
 * GETs a Helix URL, retrying network errors with fixed backoff ({@link NETWORK_RETRY_DELAYS_MS})
 * and 429s up to {@link HELIX_MAX_RETRIES} times, waiting until the `ratelimit-reset` time.
 * @param url - Full Helix URL.
 * @param headers - Request headers (auth + client ID).
 * @returns The final response, which may still be a 429 if retries ran out.
 * @throws The last network error if every attempt failed to connect.
 */
export async function fetchHelixWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await twitchFetch(url, { headers });
      break;
    } catch (err) {
      if (attempt >= NETWORK_RETRY_DELAYS_MS.length) throw err;
      const wait = NETWORK_RETRY_DELAYS_MS[attempt];
      log.warn(`Network error (attempt ${attempt + 1}), retrying in ${wait}ms`);
      await new Promise<void>((r) => setTimeout(r, wait));
    }
  }

  for (let attempt = 1; attempt <= HELIX_MAX_RETRIES && res!.status === 429; attempt++) {
    const resetHeader = res.headers.get('ratelimit-reset');
    const parsedReset = resetHeader ? Number(resetHeader) : NaN;
    const resetAt = Number.isFinite(parsedReset) ? parsedReset * 1000 : Date.now() + 5_000;
    const wait = Math.max(0, resetAt - Date.now());
    log.warn(`Rate limited (attempt ${attempt}/${HELIX_MAX_RETRIES}). Retrying after ${wait}ms`);
    await new Promise<void>((r) => setTimeout(r, wait));
    res = await twitchFetch(url, { headers });
  }

  return res!;
}

/**
 * Fetches every `data[]` row from a Helix list endpoint across as many requests as needed to
 * cover all of `ids`, batching 100 per request (Helix's per-call cap) and querying each batch
 * as repeated `paramName=id` query params. Shared by `getUsers`/`getStreams`/`getChannelInfo`,
 * which only differ in endpoint path, query param name, and any extra fixed query string.
 * @param path Helix endpoint path under `/helix/`, e.g. `'users'`.
 * @param paramName Query parameter name repeated once per id, e.g. `'login'`.
 * @param ids The ids/logins to fetch, batched 100 per request.
 * @param label Human-readable label used in the thrown error message on failure.
 * @param extraQuery Optional fixed query string suffix appended to every batch request (e.g. `'&first=100'`).
 * @returns The concatenated `data[]` rows across all batches, in Helix's response shape.
 * @throws If any batch request returns a non-OK response.
 */
async function fetchHelixPaged<T>(
  path: string,
  paramName: string,
  ids: string[],
  label: string,
  extraQuery = '',
): Promise<T[]> {
  if (ids.length === 0) return [];
  const token = await getAppToken();
  const results: T[] = [];
  for (const batch of chunks(ids, 100)) {
    const params = batch.map((id) => `${paramName}=${encodeURIComponent(id)}`).join('&');
    const res = await fetchHelixWithRetry(`https://api.twitch.tv/helix/${path}?${params}${extraQuery}`, authHeaders(token));
    throwOnHelixError(res, label);
    const data = await res.json() as { data: T[] };
    results.push(...data.data);
  }
  return results;
}

export interface TwitchUser {
  login: string;
  id: string;
}

/**
 * Looks up Twitch users by login name, via Helix, batched 100 per request.
 * @param logins - Twitch login names to look up.
 * @returns Matching users (login + id); logins Twitch doesn't recognize are simply omitted.
 * @throws If any batch request returns a non-OK response.
 */
export async function getUsers(logins: string[]): Promise<TwitchUser[]> {
  const rows = await fetchHelixPaged<{ login: string; id: string }>('users', 'login', logins, 'getUsers');
  return rows.map((u) => ({ login: u.login, id: u.id }));
}

export interface TwitchStream {
  user_id: string;
  user_login: string;
  game_name: string;
  title: string;
  thumbnail_url: string;
  /** 'live' when streaming, '' when not */
  type: string;
  /** ISO 8601 time the stream went live (Helix always sends it; optional for older fixtures). */
  started_at?: string;
}

/**
 * Looks up live stream info for a set of Twitch user IDs, via Helix, batched 100 per request.
 * @param userIds - Twitch user IDs to look up.
 * @returns Stream info for currently-live channels among `userIds`; offline channels are omitted.
 * @throws If any batch request returns a non-OK response.
 */
export async function getStreams(userIds: string[]): Promise<TwitchStream[]> {
  return fetchHelixPaged<TwitchStream>('streams', 'user_id', userIds, 'getStreams', '&first=100');
}

export interface TwitchChannelInfo {
  broadcaster_id: string;
  broadcaster_login: string;
  game_name: string;
  title: string;
}

/**
 * Looks up channel info (title/game) for a set of Twitch broadcaster IDs, via Helix, batched
 * 100 per request.
 * @param broadcasterIds - Twitch broadcaster (user) IDs to look up.
 * @returns Channel info for each broadcaster Twitch recognizes; unknown ids are omitted.
 * @throws If any batch request returns a non-OK response.
 */
export async function getChannelInfo(broadcasterIds: string[]): Promise<TwitchChannelInfo[]> {
  return fetchHelixPaged<TwitchChannelInfo>('channels', 'broadcaster_id', broadcasterIds, 'getChannelInfo');
}

/** A single follower record, as returned by Twitch's Get Channel Followers endpoint. */
export interface TwitchChannelFollower {
  user_id: string;
  user_login: string;
  user_name: string;
  /** RFC3339 timestamp of when the user followed the channel. */
  followed_at: string;
}

/**
 * Looks up whether `userId` follows `broadcasterId`, via Helix's Get Channel Followers endpoint
 * filtered to that one user. Requires a user token with the `moderator:read:followers` scope
 * belonging to the broadcaster (or one of their moderators) — app tokens can't read follow dates.
 * Wrapped in fetchHelixWithRetry: a chat-triggered read, so a transient network error is worth retrying.
 * @param broadcasterId - Twitch user ID of the channel being followed.
 * @param userId - Twitch user ID of the (possible) follower.
 * @param userToken - Broadcaster OAuth user token with the moderator:read:followers scope.
 * @returns The follow record, or null if `userId` doesn't follow `broadcasterId`.
 * @throws If Twitch returns a non-OK status (e.g. 401 for a token missing the scope).
 */
export async function getChannelFollower(
  broadcasterId: string,
  userId: string,
  userToken: string,
): Promise<TwitchChannelFollower | null> {
  const url = `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(userId)}`;
  const res = await fetchHelixWithRetry(url, authHeaders(userToken));
  assertHelixOk(res, 'getChannelFollower');
  const data = await res.json() as { data: TwitchChannelFollower[] };
  return data.data[0] ?? null;
}


interface SharedChatParticipant {
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
 * @param broadcasterId - Twitch user ID of the broadcaster to look up.
 * @returns The broadcaster's shared chat session, or null on 404/403.
 */
export async function getSharedChatSession(broadcasterId: string): Promise<SharedChatSession | null> {
  const token = await getAppToken();
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/shared_chat/session?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404 || res.status === 403) return null;
  throwOnHelixError(res, 'getSharedChatSession');
  const data = await res.json() as { data: SharedChatSession[] };
  return data.data[0] ?? null;
}

