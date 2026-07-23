/**
 * In-memory record of which trivia round group each connected channel's overlay currently
 * belongs to — the Discord guild ID a streamer explicitly appends to their OBS browser-source URL
 * (`?guild=...`, copied from their community's `/streams` dashboard), or the channel's own login
 * when no guild was given (a solo group). Deliberately not inferred from any roster/membership
 * data in the DB: a streamer picks who they're playing a synchronized round with by pasting the
 * same guild-tagged URL, rather than the bot guessing a single "home" community for them.
 *
 * Written by `triviaOverlaySource.ts` on every SSE connect; read by both
 * `triviaOverlaySource.ts` (to find which other connected logins share a group, for event
 * fan-out) and `triviaTwitchHandler.ts` (to resolve which round a chat answer counts toward).
 */
const groupKeyByLogin = new Map<string, string>();

/** Records `login`'s current trivia group key. Last write wins if it reconnects with a different one. */
export function setChannelGroupKey(login: string, groupKey: string): void {
  groupKeyByLogin.set(login, groupKey);
}

/** Returns every currently-tracked login whose recorded group key is `groupKey`. */
export function getChannelsInGroup(groupKey: string): string[] {
  const result: string[] = [];
  for (const [login, key] of groupKeyByLogin) {
    if (key === groupKey) result.push(login);
  }
  return result;
}

/**
 * Resolves a channel's current trivia group key: whatever was last recorded for it via
 * {@link setChannelGroupKey}, or its own login if its overlay has never connected.
 */
export function resolveTriviaGroupKey(login: string): string {
  return groupKeyByLogin.get(login) ?? login;
}

/** Test-only: clears every recorded channel → group key mapping. */
export function __resetTriviaChannelGroupForTests(): void {
  groupKeyByLogin.clear();
}
