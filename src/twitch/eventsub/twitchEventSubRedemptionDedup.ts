/** How long a redemption id is remembered for deduplication (ms). */
export const REDEMPTION_DEDUP_TTL_MS = 10 * 60 * 1000;

// TTL-based dedup keyed by Twitch's own redemption id, not the EventSub message envelope id.
// twitchEventSubConnection.ts's message_id dedup (isDuplicate/seenMessageIds) only catches the
// same WebSocket delivery being replayed (e.g. during a documented session-migration window); it
// can't catch the same physical redemption arriving via two independently-"enabled" subscriptions
// (e.g. a stale subscription left over from a prior process that Twitch hasn't yet revoked, or
// two bot instances briefly running against the same channel) — those arrive as distinct messages
// with distinct message_ids but carry the same redemption `event.id`. Mirrors that module's
// TTL-map-plus-interval-purge shape so both dedup caches behave the same way operationally.
export const seenRedemptionIds = new Map<string, number>();

/** Removes all expired entries from the deduplication map. */
export function purgeExpiredRedemptionIds(): void {
  const now = Date.now();
  for (const [id, expiry] of seenRedemptionIds) {
    if (expiry < now) seenRedemptionIds.delete(id);
  }
}

// Purge expired entries on a fixed interval so isDuplicateRedemption stays O(1).
setInterval(purgeExpiredRedemptionIds, REDEMPTION_DEDUP_TTL_MS).unref();

/** Returns true if redemptionId has been seen within REDEMPTION_DEDUP_TTL_MS; records it otherwise. */
export function isDuplicateRedemption(redemptionId: string): boolean {
  const now = Date.now();
  const expiry = seenRedemptionIds.get(redemptionId);
  if (expiry !== undefined && now <= expiry) return true;
  seenRedemptionIds.set(redemptionId, now + REDEMPTION_DEDUP_TTL_MS);
  return false;
}
