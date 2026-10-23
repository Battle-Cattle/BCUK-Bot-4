/**
 * Throws the standard `[TwitchAPI] ${label} failed: ${status}` error for a non-OK Twitch
 * response; no-ops if `res.ok`. Side-effect free, so it's safe for calls authenticated with a
 * broadcaster user token: an app-token call should go through `twitchApi.ts`'s
 * `throwOnHelixError` instead, which also clears the cached app token on a 401.
 * @param res - Twitch response to check.
 * @param label - Name of the failing call, used in the error message.
 * @throws If `res` is not OK.
 */
export function assertHelixOk(res: Response, label: string): void {
  if (!res.ok) throw new Error(`[TwitchAPI] ${label} failed: ${res.status}`);
}
