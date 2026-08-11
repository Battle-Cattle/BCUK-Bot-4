import { createLogger } from '../shared/logger';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from '../shared/config';

const log = createLogger('TwitchAPI');

const FETCH_TIMEOUT_MS = 10_000;

export function twitchFetch(url: string, init?: RequestInit): Promise<Response> {
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

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Client-Id': TWITCH_CLIENT_ID,
  };
}

/**
 * Clears the cached app token on a 401 response, so the next call re-fetches rather than
 * reusing an invalidated token until `appTokenExpiry`. No-ops for any other status.
 */
function invalidateAppTokenIfUnauthorized(res: Response): void {
  if (res.status === 401) { cachedAppToken = null; appTokenExpiry = 0; }
}

/**
 * Throws a generic `[TwitchAPI] ${label} failed: ${status}` error for a non-OK app-token-authed
 * Helix response, first clearing the cached app token if the failure was a 401. Shared by
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
  throw new Error(`[TwitchAPI] ${label} failed: ${res.status}`);
}

function chunks<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunks: size must be > 0, got ${size}`);
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

const HELIX_MAX_RETRIES = 3;

const NETWORK_RETRY_DELAYS_MS = [2_000, 4_000];

async function fetchHelixWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
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

/** A custom reward's per-stream redemption limit, as returned by Twitch (`max_per_stream_setting`). */
export interface TwitchMaxPerStreamSetting {
  is_enabled: boolean;
  max_per_stream: number;
}

/** A custom reward's per-user-per-stream redemption limit, as returned by Twitch (`max_per_user_per_stream_setting`). */
export interface TwitchMaxPerUserPerStreamSetting {
  is_enabled: boolean;
  max_per_user_per_stream: number;
}

/** A custom reward's global cooldown, as returned by Twitch (`global_cooldown_setting`). */
export interface TwitchGlobalCooldownSetting {
  is_enabled: boolean;
  global_cooldown_seconds: number;
}

export interface TwitchCustomReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  prompt: string;
  is_user_input_required: boolean;
  background_color: string;
  is_paused: boolean;
  is_in_stock: boolean;
  should_redemptions_skip_request_queue: boolean;
  max_per_stream_setting: TwitchMaxPerStreamSetting;
  max_per_user_per_stream_setting: TwitchMaxPerUserPerStreamSetting;
  global_cooldown_setting: TwitchGlobalCooldownSetting;
}

/**
 * Builds the Helix custom-rewards endpoint URL for a broadcaster, optionally scoped to one
 * reward id. Shared by every custom-reward call (`getCustomRewards`, `createCustomReward`,
 * `updateCustomReward`, `deleteCustomReward`) so the endpoint path and query-param names live
 * in exactly one place.
 * @param broadcasterId Twitch user ID whose custom rewards to target.
 * @param rewardId Optional reward UUID to scope the URL to a single reward.
 * @returns The full Helix custom-rewards URL.
 */
function customRewardUrl(broadcasterId: string, rewardId?: string): string {
  const base = `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(broadcasterId)}`;
  return rewardId ? `${base}&id=${encodeURIComponent(rewardId)}` : base;
}

/**
 * Lists a broadcaster's custom rewards via Helix. Unlike its create/update/delete siblings, a
 * 403 (the broadcaster is not a Twitch Partner or Affiliate, so channel points aren't available)
 * is treated as "no rewards" rather than a typed error, since listing is read-only and callers
 * generally just want to render whatever's available.
 * @param broadcasterId - Twitch user ID whose custom rewards to list.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @returns The broadcaster's custom rewards, or `[]` on a 403.
 * @throws If Twitch returns a non-OK, non-403 status.
 */
export async function getCustomRewards(broadcasterId: string, userToken: string): Promise<TwitchCustomReward[]> {
  const res = await twitchFetch(customRewardUrl(broadcasterId), { headers: authHeaders(userToken) });
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(`[TwitchAPI] getCustomRewards failed: ${res.status}`);
  const data = await res.json() as { data: TwitchCustomReward[] };
  return data.data;
}

/** A single channel-points redemption, as returned by Twitch's Get Custom Reward Redemptions endpoint. */
export interface TwitchRewardRedemption {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: string;
  redeemed_at: string;
  reward: { id: string; title: string; prompt: string; cost: number };
}

/**
 * Lists a broadcaster's most recent redemptions for one custom reward and status, via Helix,
 * newest first. Used by the EventSub reconciliation poll to catch redemptions the WebSocket
 * connection missed (e.g. during a reconnect gap) — the live notification path is driven
 * entirely by EventSub and never calls this.
 *
 * @param broadcasterId - Twitch user ID whose reward redemptions to list.
 * @param rewardId - Twitch reward UUID to scope the query to.
 * @param status - Redemption status to filter on. Callers must check both 'UNFULFILLED' and
 *   'FULFILLED' to cover both queue-held and auto-fulfilled (`should_redemptions_skip_request_queue`)
 *   redemptions — Twitch requires exactly one status per call.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @returns Up to the 50 most recent matching redemptions, or `[]` on a 403 (reward not owned by
 *   this app's client_id, or channel points unavailable for the broadcaster).
 * @throws If Twitch returns a non-OK, non-403 status.
 */
export async function getRewardRedemptions(
  broadcasterId: string, rewardId: string, status: 'UNFULFILLED' | 'FULFILLED', userToken: string,
): Promise<TwitchRewardRedemption[]> {
  const url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&reward_id=${encodeURIComponent(rewardId)}&status=${status}&sort=NEWEST_FIRST&first=50`;
  const res = await twitchFetch(url, { headers: authHeaders(userToken) });
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(`[TwitchAPI] getRewardRedemptions failed: ${res.status}`);
  const data = await res.json() as { data: TwitchRewardRedemption[] };
  return data.data;
}

/**
 * Thrown when Twitch returns 403 for a reward create/update/delete/cost-update call — Twitch
 * only allows the app that created a reward to manage it (or, on create, the broadcaster may
 * not have channel points available), so this is permanent, not a transient failure worth
 * retrying.
 */
export class TwitchRewardUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitchRewardUnsupportedError';
  }
}

/**
 * Thrown when Twitch returns 401 for a reward create/update/delete/cost-update call — the
 * broadcaster token is invalid, or (most commonly) lacks the `channel:manage:redemptions`
 * scope. Unlike `TwitchRewardUnsupportedError`, this is not permanent for the reward:
 * reconnecting the streamer's Twitch account (to grant the scope, or replace a revoked
 * token) resolves it.
 */
export class TwitchRewardAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitchRewardAuthError';
  }
}

/** Fields accepted by Twitch's create/update custom reward endpoints. */
export interface CustomRewardInput {
  title: string;
  cost: number;
  prompt?: string;
  is_enabled?: boolean;
  background_color?: string;
  is_user_input_required?: boolean;
  is_max_per_stream_enabled?: boolean;
  max_per_stream?: number;
  is_max_per_user_per_stream_enabled?: boolean;
  max_per_user_per_stream?: number;
  is_global_cooldown_enabled?: boolean;
  global_cooldown_seconds?: number;
  should_redemptions_skip_request_queue?: boolean;
}

/** Throws the standard reward-management errors for a non-OK Helix response; otherwise no-ops. */
function throwForRewardManagementFailure(res: Response, label: string, rewardId?: string): void {
  const suffix = rewardId ? ` reward ${rewardId}` : '';
  if (res.status === 403) throw new TwitchRewardUnsupportedError(`[TwitchAPI] ${label}:${suffix} cannot be managed by this app (403)`);
  if (res.status === 401) throw new TwitchRewardAuthError(`[TwitchAPI] ${label}: broadcaster token invalid or missing scope${suffix} (401)`);
  if (!res.ok) throw new Error(`[TwitchAPI] ${label} failed: ${res.status}`);
}

/**
 * Creates a new custom reward on Twitch via Helix. Requires a broadcaster user token with the
 * channel:manage:redemptions scope (app tokens cannot manage custom rewards). Not wrapped in
 * fetchHelixWithRetry — this is a synchronous admin action; on failure the caller shows an
 * error and lets the streamer retry, rather than silently retrying in the background.
 *
 * @param broadcasterId - Twitch user ID to create the reward for.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @param input - The reward's fields (title/cost required, the rest optional).
 * @throws {TwitchRewardUnsupportedError} When Twitch returns 403 (channel points aren't
 *   available for the broadcaster, e.g. not affiliate/partner).
 * @throws {TwitchRewardAuthError} When Twitch returns 401 (invalid token, or missing the
 *   channel:manage:redemptions scope).
 */
export async function createCustomReward(broadcasterId: string, userToken: string, input: CustomRewardInput): Promise<TwitchCustomReward> {
  const res = await twitchFetch(customRewardUrl(broadcasterId), {
    method: 'POST',
    headers: { ...authHeaders(userToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  throwForRewardManagementFailure(res, 'createCustomReward');
  const data = await res.json() as { data: TwitchCustomReward[] };
  return data.data[0];
}

/**
 * Updates any subset of a custom reward's fields on Twitch via Helix. Requires a broadcaster
 * user token with the channel:manage:redemptions scope. Only rewards created by this app's
 * client_id can be updated — Twitch returns 403 otherwise. Not wrapped in fetchHelixWithRetry,
 * for the same reason as `createCustomReward`.
 *
 * @param broadcasterId - Twitch user ID of the reward's broadcaster.
 * @param rewardId - Twitch reward UUID to update.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @param input - The fields to update; omitted fields are left unchanged on Twitch.
 * @throws {TwitchRewardUnsupportedError} When Twitch returns 403 (reward created by a
 *   different client_id, or channel points aren't available for the broadcaster).
 * @throws {TwitchRewardAuthError} When Twitch returns 401 (invalid token, or missing the
 *   channel:manage:redemptions scope).
 */
export async function updateCustomReward(
  broadcasterId: string, rewardId: string, userToken: string, input: Partial<CustomRewardInput>,
): Promise<TwitchCustomReward> {
  const res = await twitchFetch(customRewardUrl(broadcasterId, rewardId), {
    method: 'PATCH',
    headers: { ...authHeaders(userToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  throwForRewardManagementFailure(res, 'updateCustomReward', rewardId);
  const data = await res.json() as { data: TwitchCustomReward[] };
  return data.data[0];
}

/**
 * Deletes a custom reward from Twitch via Helix. Requires a broadcaster user token with the
 * channel:manage:redemptions scope. Only rewards created by this app's client_id can be
 * deleted — Twitch returns 403 otherwise.
 *
 * @param broadcasterId - Twitch user ID of the reward's broadcaster.
 * @param rewardId - Twitch reward UUID to delete.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @throws {TwitchRewardUnsupportedError} When Twitch returns 403 (reward created by a
 *   different client_id).
 * @throws {TwitchRewardAuthError} When Twitch returns 401 (invalid token, or missing the
 *   channel:manage:redemptions scope).
 */
export async function deleteCustomReward(broadcasterId: string, rewardId: string, userToken: string): Promise<void> {
  const res = await twitchFetch(customRewardUrl(broadcasterId, rewardId), { method: 'DELETE', headers: authHeaders(userToken) });
  throwForRewardManagementFailure(res, 'deleteCustomReward', rewardId);
}

/**
 * Updates a custom reward's cost on Twitch via Helix. Thin wrapper over `updateCustomReward`
 * kept for its narrower, unchanged signature — the dynamic pricing sync (`rewardPricingService.ts`)
 * only ever needs to push a cost, and tolerates a failed push by retrying on the next
 * redemption/decay tick.
 *
 * @param broadcasterId - Twitch user ID of the reward's broadcaster.
 * @param rewardId - Twitch reward UUID to update.
 * @param cost - The new channel-point cost.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @throws {TwitchRewardUnsupportedError} When Twitch returns 403 (reward created by a
 *   different client_id, or channel points aren't available for the broadcaster).
 * @throws {TwitchRewardAuthError} When Twitch returns 401 (invalid token, or missing the
 *   channel:manage:redemptions scope).
 */
export async function updateRewardCost(broadcasterId: string, rewardId: string, cost: number, userToken: string): Promise<void> {
  await updateCustomReward(broadcasterId, rewardId, userToken, { cost });
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
  throwOnHelixError(res, 'getSharedChatSession');
  const data = await res.json() as { data: SharedChatSession[] };
  return data.data[0] ?? null;
}

