// Helix channel-points calls: custom rewards (list/create/update/delete) and their redemptions.
// All authenticate with a broadcaster user token, so a 401 never touches the cached app token.
import { authHeaders, fetchHelixWithRetry, twitchFetch } from './twitchApi';
import { assertHelixOk } from './helixErrors';

/** A custom reward's per-stream redemption limit, as returned by Twitch (`max_per_stream_setting`). */
interface TwitchMaxPerStreamSetting {
  is_enabled: boolean;
  max_per_stream: number;
}

/** A custom reward's per-user-per-stream redemption limit, as returned by Twitch (`max_per_user_per_stream_setting`). */
interface TwitchMaxPerUserPerStreamSetting {
  is_enabled: boolean;
  max_per_user_per_stream: number;
}

/** A custom reward's global cooldown, as returned by Twitch (`global_cooldown_setting`). */
interface TwitchGlobalCooldownSetting {
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
 * generally just want to render whatever's available. Wrapped in fetchHelixWithRetry, unlike
 * create/update/delete: this is a read used by the background reconciliation poll, not a
 * synchronous admin action, so a transient network error is worth retrying rather than surfacing.
 * @param broadcasterId - Twitch user ID whose custom rewards to list.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @param options - Optional listing filters.
 * @param options.onlyManageable - List only rewards this app's client ID created (Helix
 *   `only_manageable_rewards`). Twitch only lets an app read or update redemptions of those, so a
 *   caller that goes on to fetch redemptions should set this rather than query rewards it can't use.
 * @returns The broadcaster's custom rewards, or `[]` on a 403.
 * @throws If Twitch returns a non-OK, non-403 status.
 */
export async function getCustomRewards(
  broadcasterId: string,
  userToken: string,
  options?: { onlyManageable?: boolean },
): Promise<TwitchCustomReward[]> {
  const url = customRewardUrl(broadcasterId) + (options?.onlyManageable ? '&only_manageable_rewards=true' : '');
  const res = await fetchHelixWithRetry(url, authHeaders(userToken));
  if (res.status === 403) return [];
  assertHelixOk(res, 'getCustomRewards');
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

/** One page of {@link getRewardRedemptions} results, plus the cursor to fetch the next page (if any). */
export interface TwitchRewardRedemptionPage {
  redemptions: TwitchRewardRedemption[];
  /** Pass as `after` to fetch the next page; null once there are no more pages. */
  cursor: string | null;
}

/**
 * Lists one page (up to 50) of a broadcaster's redemptions for one custom reward and status, via
 * Helix, newest first. Used by the EventSub reconciliation poll to catch redemptions the
 * WebSocket connection missed (e.g. during a reconnect gap) — the live notification path is
 * driven entirely by EventSub and never calls this. Wrapped in fetchHelixWithRetry: this poll
 * runs unattended in the background, so a transient network error should be retried rather than
 * surfaced — unlike the reward create/update/delete calls, which are synchronous admin actions
 * and leave retrying to the caller.
 *
 * @param broadcasterId - Twitch user ID whose reward redemptions to list.
 * @param rewardId - Twitch reward UUID to scope the query to.
 * @param status - Redemption status to filter on. Callers must check both 'UNFULFILLED' and
 *   'FULFILLED' to cover both queue-held and auto-fulfilled (`should_redemptions_skip_request_queue`)
 *   redemptions — Twitch requires exactly one status per call.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @param after - Pagination cursor from a previous call's `cursor`, to fetch the next page.
 * @returns Up to 50 matching redemptions (newest first) plus a cursor for the next page, or an
 *   empty page with a null cursor on a 403 (reward not owned by this app's client_id, or channel
 *   points unavailable for the broadcaster).
 * @throws If Twitch returns a non-OK, non-403 status.
 */
export async function getRewardRedemptions(
  broadcasterId: string, rewardId: string, status: 'UNFULFILLED' | 'FULFILLED', userToken: string, after?: string,
): Promise<TwitchRewardRedemptionPage> {
  let url = `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&reward_id=${encodeURIComponent(rewardId)}&status=${status}&sort=NEWEST&first=50`;
  if (after) url += `&after=${encodeURIComponent(after)}`;
  const res = await fetchHelixWithRetry(url, authHeaders(userToken));
  if (res.status === 403) return { redemptions: [], cursor: null };
  assertHelixOk(res, 'getRewardRedemptions');
  const data = await res.json() as { data: TwitchRewardRedemption[]; pagination?: { cursor?: string } };
  return { redemptions: data.data, cursor: data.pagination?.cursor ?? null };
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

/**
 * Throws the standard reward-management errors for a non-OK Helix response; otherwise no-ops.
 * @param res - Helix response from a custom-reward create/update/delete call.
 * @param label - Calling function's name, used in the error message.
 * @param rewardId - Twitch reward UUID to name in the message, if the call targeted one.
 * @throws {TwitchRewardUnsupportedError} On 403.
 * @throws {TwitchRewardAuthError} On 401.
 */
function throwForRewardManagementFailure(res: Response, label: string, rewardId?: string): void {
  const suffix = rewardId ? ` reward ${rewardId}` : '';
  if (res.status === 403) throw new TwitchRewardUnsupportedError(`[TwitchAPI] ${label}:${suffix} cannot be managed by this app (403)`);
  if (res.status === 401) throw new TwitchRewardAuthError(`[TwitchAPI] ${label}: broadcaster token invalid or missing scope${suffix} (401)`);
  assertHelixOk(res, label);
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
 * @returns The created reward as Twitch returned it (including its new id).
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
  const reward = data.data[0];
  if (!reward) throw new Error('[TwitchAPI] createCustomReward returned empty data');
  return reward;
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
 * @returns The reward's full state after the update, as Twitch returned it.
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
  const reward = data.data[0];
  if (!reward) throw new Error('[TwitchAPI] updateCustomReward returned empty data');
  return reward;
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

/**
 * Thrown when Twitch returns 404 for a redemption status update — the redemption doesn't exist,
 * or is no longer `UNFULFILLED` (already fulfilled or cancelled, or its reward skips the request
 * queue so it was auto-fulfilled). Permanent: retrying can't change it.
 */
export class TwitchRedemptionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwitchRedemptionNotFoundError';
  }
}

/**
 * Marks an `UNFULFILLED` channel-point redemption `FULFILLED` or `CANCELED` via Helix. Cancelling
 * refunds the viewer's points. Requires a broadcaster user token with the
 * channel:manage:redemptions scope, and only works for rewards created by this app's client_id.
 *
 * @param broadcasterId - Twitch user ID of the reward's broadcaster.
 * @param rewardId - Twitch reward UUID the redemption belongs to.
 * @param redemptionId - Twitch redemption id to update.
 * @param status - `FULFILLED` to complete it, `CANCELED` to refund it.
 * @param userToken - Broadcaster OAuth user token with the channel:manage:redemptions scope.
 * @throws {TwitchRedemptionNotFoundError} When Twitch returns 404 (unknown, or no longer unfulfilled).
 * @throws {TwitchRewardUnsupportedError} When Twitch returns 403 (reward created by a different client_id).
 * @throws {TwitchRewardAuthError} When Twitch returns 401 (invalid token, or missing scope).
 */
export async function updateRedemptionStatus(
  broadcasterId: string, rewardId: string, redemptionId: string, status: 'FULFILLED' | 'CANCELED', userToken: string,
): Promise<void> {
  const url = 'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions'
    + `?broadcaster_id=${encodeURIComponent(broadcasterId)}&reward_id=${encodeURIComponent(rewardId)}&id=${encodeURIComponent(redemptionId)}`;
  const res = await twitchFetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders(userToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (res.status === 404) throw new TwitchRedemptionNotFoundError(`[TwitchAPI] updateRedemptionStatus: redemption ${redemptionId} not found or not unfulfilled (404)`);
  throwForRewardManagementFailure(res, 'updateRedemptionStatus', rewardId);
}
