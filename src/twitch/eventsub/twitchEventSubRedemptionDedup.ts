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

// Ids currently being processed by handleRedemption but not yet resolved or rejected. Kept
// separate from seenRedemptionIds so that a redemption which fails partway through (e.g. a
// transient DB error) is not permanently misclassified as "already handled" — only a redemption
// that actually completes successfully (via markRedemptionHandled) earns a TTL'd entry in
// seenRedemptionIds. This set still catches a genuine concurrent duplicate (e.g. the live
// WebSocket delivery and a reconciliation replay racing on the same id).
export const pendingRedemptionIds = new Set<string>();

/** Removes all expired entries from the deduplication map. */
export function purgeExpiredRedemptionIds(): void {
  const now = Date.now();
  for (const [id, expiry] of seenRedemptionIds) {
    if (expiry < now) seenRedemptionIds.delete(id);
  }
}

// Purge expired entries on a fixed interval so isDuplicateRedemption stays O(1).
setInterval(purgeExpiredRedemptionIds, REDEMPTION_DEDUP_TTL_MS).unref();

/**
 * Returns true if redemptionId has already completed successfully within REDEMPTION_DEDUP_TTL_MS,
 * or is currently being processed by another in-flight call. Otherwise claims the id as pending
 * (via pendingRedemptionIds) and returns false — the caller must follow up with
 * markRedemptionHandled on success or clearPendingRedemption on failure.
 */
export function isDuplicateRedemption(redemptionId: string): boolean {
  const now = Date.now();
  const expiry = seenRedemptionIds.get(redemptionId);
  if (expiry !== undefined && now <= expiry) return true;
  if (pendingRedemptionIds.has(redemptionId)) return true;
  pendingRedemptionIds.add(redemptionId);
  return false;
}

/** Marks a redemption as successfully processed: moves it from in-flight to the TTL'd completed set. */
export function markRedemptionHandled(redemptionId: string): void {
  pendingRedemptionIds.delete(redemptionId);
  seenRedemptionIds.set(redemptionId, Date.now() + REDEMPTION_DEDUP_TTL_MS);
}

/** Clears an in-flight claim without marking it completed, so a later attempt is not treated as a duplicate. */
export function clearPendingRedemption(redemptionId: string): void {
  pendingRedemptionIds.delete(redemptionId);
}
