/**
 * In-memory record of which trivia round group each connected channel's overlay currently
 * belongs to — the Discord guild ID a streamer explicitly appends to their OBS browser-source URL
 * (`?guild=...`, copied from their `/trivia/settings` page), or the channel's own login
 * when no guild was given (a solo group). Deliberately not inferred from any roster/membership
 * data in the DB: a streamer picks who they're playing a synchronized round with by pasting the
 * same guild-tagged URL, rather than the bot guessing a single "home" community for them.
 *
 * Written by `triviaOverlaySource.ts` on every SSE connect (and cleared once a channel's last
 * connection closes, so this never grows unbounded); read by `triviaTwitchHandler.ts` to resolve
 * which round a chat answer counts toward. Event fan-out to overlay connections is tracked
 * separately in `triviaOverlaySource.ts`, keyed by the connection itself rather than by login —
 * a chat message only ever has a login to key off, so this map stays login-keyed.
 */
const groupKeyByLogin = new Map<string, string>();

/** Records `login`'s current trivia group key. Last write wins if it reconnects with a different one. */
export function setChannelGroupKey(login: string, groupKey: string): void {
  groupKeyByLogin.set(login, groupKey);
}

/** Removes `login`'s recorded group key, e.g. once its last overlay connection has closed. */
export function clearChannelGroupKey(login: string): void {
  groupKeyByLogin.delete(login);
}

/**
 * Resolves a channel's current trivia group key: whatever was last recorded for it via
 * {@link setChannelGroupKey}, or its own login if its overlay has never connected (or has since
 * fully disconnected).
 */
export function resolveTriviaGroupKey(login: string): string {
  return groupKeyByLogin.get(login) ?? login;
}

/** Test-only: clears every recorded channel → group key mapping. */
export function __resetTriviaChannelGroupForTests(): void {
  groupKeyByLogin.clear();
}
