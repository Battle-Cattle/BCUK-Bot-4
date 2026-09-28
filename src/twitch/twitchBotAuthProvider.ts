import { RefreshingAuthProvider, type AccessToken } from '@twurple/auth';
import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, PUBLIC_URL } from '../shared/config';
import { sendOwnerAlert } from '../discord/ownerAlerts';
import { createLogger } from '../shared/logger';
import { saveBotChatTokenIfOwnedBy, clearBotChatTokenIfOwnedBy, type BotChatToken } from '../db';

const log = createLogger('Twitch');

/** Where the owner can (re)connect the bot's own Twitch chat account (see issue #550). */
export const BOT_AUTH_CONNECT_URL = `${PUBLIC_URL}/admin/bot-auth`;

/**
 * Whether a `RefreshingAuthProvider` refresh-failure error indicates the refresh token itself
 * is invalid/revoked, as opposed to a transient failure (network error, timeout, 5xx) or some
 * other client-configuration/request error (including a missing/malformed refresh token, which
 * mentions "refresh token" but isn't evidence the stored one is bad) that a later retry could
 * still recover from. A 400 or 401 status alone isn't enough — Twitch returns the same statuses
 * for an invalid client secret or a malformed request — so this also parses the response body
 * and requires its message to both mention the refresh token *and* say it's invalid/revoked
 * (Twitch's documented example: `{"message": "Invalid refresh token"}`), not just mention it.
 * Duck-typed on `statusCode`/`body` rather than an `instanceof` check against `@twurple/api-call`'s
 * `HttpStatusCodeError` — that package is only a transitive dependency of `@twurple/auth`, not
 * one we declare directly.
 * @param error - The error `onRefreshFailure` was called with.
 * @returns True if this looks like a genuinely invalid/revoked refresh token.
 */
function isInvalidRefreshTokenError(error: Error): boolean {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (statusCode !== 400 && statusCode !== 401) return false;

  const rawBody = (error as { body?: unknown }).body;
  if (typeof rawBody !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const message = parsed && typeof parsed === 'object' && 'message' in parsed ? (parsed as { message?: unknown }).message : undefined;
    if (typeof message !== 'string') return false;
    const lower = message.toLowerCase();
    return lower.includes('refresh token') && (lower.includes('invalid') || lower.includes('revoked'));
  } catch {
    return false;
  }
}

/**
 * Recovers from a transient (non-invalid-token) refresh failure by rebuilding the chat connection
 * from the still-stored, still-valid token, via `restart` (`twitchBot.ts`'s `restartTwitchBot`,
 * passed in rather than imported directly to avoid a circular import between the two modules).
 * This exists because `RefreshingAuthProvider` permanently caches a refresh failure per user for
 * the life of the provider instance and never retries it on its own — see
 * {@link buildBotAuthProvider}'s doc for why merely leaving the old provider in place would
 * silently and permanently break chat auth for a blip that Twitch itself has already recovered
 * from. Building a *new* provider (via `startTwitchBot()` reading the same, unchanged,
 * still-stored token) starts with a clean failure cache, so a later refresh can actually be
 * attempted again instead of requiring a manual process restart. Only alerts the owner if the
 * rebuild itself fails to reconnect — a successful rebuild is a self-healed blip and not worth
 * paging anyone for; a rebuild that can't reconnect (e.g. an ongoing Twitch outage) is exactly the
 * "can't fix itself" case the owner needs to know about. `restart`'s own serialization means this
 * can't race a concurrent `/admin/bot-auth` reconnect: if a newer connection has already been
 * saved by the time this runs, it reconnects with that current token instead.
 * @param userId - The Twitch user ID `onRefreshFailure` fired for, for logging only.
 * @param restart - `restartTwitchBot`, injected by the caller.
 */
async function rebuildAfterTransientRefreshFailure(userId: string, restart: () => Promise<void>): Promise<void> {
  log.warn(`Refresh failure for ${userId} does not look like a revoked/invalid token — rebuilding the chat connection from the still-stored token.`);
  try {
    await restart();
  } catch (restartErr) {
    log.error(`Failed to rebuild the chat connection after a transient refresh failure for ${userId}:`, restartErr);
    void sendOwnerAlert(
      `🟠 Twitch chat bot's token refresh failed and the automatic reconnect also failed. Check server logs — reconnect manually at ${BOT_AUTH_CONNECT_URL} if this persists.`,
    );
  }
}

/**
 * Builds a `RefreshingAuthProvider` seeded with the bot's own stored chat token, wired to
 * persist a refreshed token back to the DB (`onRefresh`) and, on a refresh failure that looks
 * like a genuinely invalid/revoked refresh token (see {@link isInvalidRefreshTokenError}), to
 * clear it, disconnect the now-dead chat session, and alert the owner. A transient failure
 * (network error, timeout, 5xx) instead rebuilds the connection from the still-stored token (see
 * {@link rebuildAfterTransientRefreshFailure}) rather than merely leaving it in place: Twurple's
 * `RefreshingAuthProvider` permanently caches a refresh failure per user for the life of the
 * provider instance (`_cachedRefreshFailures`) and never retries it on its own, so without a
 * rebuild a single transient blip would silently and permanently break chat auth in this process
 * until a manual restart — even though the stored token itself is still perfectly valid. Replaces
 * the old `StaticAuthProvider` seeded from the static `TWITCH_OAUTH_TOKEN` env var (see #550). Its
 * `onRefresh`/`onRefreshFailure` callbacks are guarded against a reconnect superseding this
 * provider while one of them is in flight via a database-level compare-and-swap
 * (`saveBotChatTokenIfOwnedBy`/`clearBotChatTokenIfOwnedBy`, keyed to `stored.connectionId`, the
 * row's `connection_id` at the moment this provider was built): a write that started before a
 * reconnect but completes after it finds `connection_id` already bumped past that value and is
 * dropped as a no-op instead of clobbering the newer connection's token. Keyed on `connection_id`
 * rather than the Twitch user ID specifically so a reconnect to the *same* account is covered
 * too, not just a reconnect to a different one — see the discussion on PR #666.
 * @param stored - The bot's decrypted chat token, as loaded from the DB.
 * @param restart - `twitchBot.ts`'s `restartTwitchBot`, injected by the caller rather than
 *   imported directly — this module builds the auth provider `twitchBot.ts` uses, so importing
 *   `restartTwitchBot` from there directly would create a circular import between the two.
 * @returns A `RefreshingAuthProvider` with the bot's user already added under the `chat` intent.
 */
export function buildBotAuthProvider(stored: BotChatToken, restart: () => Promise<void>): RefreshingAuthProvider {
  const authProvider = new RefreshingAuthProvider({ clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET });
  const { connectionId } = stored;

  authProvider.onRefresh(async (userId, newToken) => {
    const expiryMs = newToken.expiresIn != null ? Date.now() + newToken.expiresIn * 1000 - 60_000 : null;
    const saved = await saveBotChatTokenIfOwnedBy(connectionId, newToken.accessToken, newToken.refreshToken!, expiryMs);
    if (!saved) log.warn(`Dropped a refreshed token for ${userId} — a reconnect replaced this connection first.`);
  });
  authProvider.onRefreshFailure(async (userId, error) => {
    log.error(`Failed to refresh chat token for ${userId}: ${error.message}`);
    if (!isInvalidRefreshTokenError(error)) {
      await rebuildAfterTransientRefreshFailure(userId, restart);
      return;
    }
    const cleared = await clearBotChatTokenIfOwnedBy(connectionId);
    if (!cleared) {
      log.warn(`Not clearing the stored token for ${userId} — a reconnect replaced this connection first.`);
      return;
    }
    // Disconnect the now-credential-less chat session immediately rather than leaving it running
    // on its last-known (still-live-for-now) access token until Twitch eventually rejects it —
    // restart() is used (not a bare stop) so this serializes against a concurrent /admin/bot-auth
    // reconnect instead of racing it: if a newer connection has already been saved by the time
    // this runs, it just reconnects with that current token instead of leaving chat down. Failure
    // here is logged but never suppresses the owner alert below — the DB is already cleared
    // either way, so the owner must be told.
    try {
      await restart();
    } catch (restartErr) {
      log.error(`Failed to disconnect the chat client after clearing ${userId}'s revoked token:`, restartErr);
    }
    void sendOwnerAlert(`🔴 Twitch chat bot's token was revoked/expired and could not refresh. Reconnect it at ${BOT_AUTH_CONNECT_URL}`);
  });

  const now = Date.now();
  const initialToken: AccessToken = {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    scope: ['chat:read', 'chat:edit'],
    expiresIn: stored.tokenExpiry != null ? Math.max(0, Math.floor((stored.tokenExpiry - now) / 1000)) : null,
    obtainmentTimestamp: now,
  };
  authProvider.addUser(stored.twitchUserId, initialToken, ['chat']);

  return authProvider;
}
