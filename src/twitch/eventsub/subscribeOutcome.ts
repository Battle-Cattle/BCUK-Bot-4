// The result of one EventSub subscribe pass, and the rule for when a connection gives up on it.

/**
 * Outcome of one {@link subscribeForStreamer} pass, used by `StreamerConnection` to decide between
 * keeping the connection, retrying the subscribe step, or stopping itself.
 * - `desired`: subscription specs wanted for this streamer (0 = nothing to do — e.g. bot not in
 *   channel, no token, or every group disabled).
 * - `live`: specs created, confirmed already-live on this session, or reported by Twitch as
 *   already existing (409 Conflict).
 * - `transientFailures`: specs whose create failed for a reason other than an auth/scope error
 *   (`TwitchAuthError` — 401/403 or a previously auth-failed token+type), e.g. a 5xx, 429, network
 *   error or timeout — worth retrying, unlike an auth failure, which needs the user to reconnect.
 */
export interface SubscribeOutcome {
  desired: number;
  live: number;
  transientFailures: number;
}

/**
 * Whether a connection should stop itself after a subscribe pass: nothing is desired, or nothing
 * is live and no create failed transiently (every failure was auth/scope, which retrying can't fix
 * until the user reconnects Twitch).
 * @param outcome - The subscribe pass's result.
 * @returns true if the connection should self-stop.
 */
export function shouldSelfStop(outcome: SubscribeOutcome): boolean {
  return outcome.desired === 0 || (outcome.live === 0 && outcome.transientFailures === 0);
}
