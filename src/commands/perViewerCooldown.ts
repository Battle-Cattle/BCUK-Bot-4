/** A per-(streamer, viewer) cooldown whose length is supplied on each call (it's configurable per
 *  streamer via `LoyaltyPointsConfig.cooldownSeconds`, which `cooldownGate.ts`'s fixed-length
 *  `createCooldownGate()` doesn't support). */
export interface PerViewerCooldown {
  tryClaim(streamerId: number, twitchUsername: string, cooldownSeconds: number): boolean;
  getRemainingSeconds(streamerId: number, twitchUsername: string, cooldownSeconds: number): number;
  clear(): void;
}

/** Builds the composite key: cooldowns are per-streamer, so the same viewer on two different
 *  streamers' channels must never share one. */
function cooldownKey(streamerId: number, twitchUsername: string): string {
  return `${streamerId}:${twitchUsername}`;
}

/**
 * Creates an independent per-(streamer, viewer) cooldown. Each caller gets its own state, so e.g.
 * passive chat-earn and `!gamble` never block each other.
 * @returns The new cooldown tracker.
 */
export function createPerViewerCooldown(): PerViewerCooldown {
  const lastClaimedAt = new Map<string, number>();

  return {
    /**
     * Claims the cooldown for a (streamer, viewer) pair if they're off it, recording the claim time.
     * @param streamerId - The streamer's `streamer.id`.
     * @param twitchUsername - The viewer's Twitch login.
     * @param cooldownSeconds - The cooldown length.
     * @returns True if the claim succeeded; false (leaving the recorded time untouched) if still on cooldown.
     */
    tryClaim(streamerId: number, twitchUsername: string, cooldownSeconds: number): boolean {
      const key = cooldownKey(streamerId, twitchUsername);
      const now = Date.now();
      if (now - (lastClaimedAt.get(key) ?? 0) < cooldownSeconds * 1000) return false;
      lastClaimedAt.set(key, now);
      return true;
    },

    /**
     * Returns how many whole seconds remain before a pair is off cooldown, without claiming it.
     * @param streamerId - The streamer's `streamer.id`.
     * @param twitchUsername - The viewer's Twitch login.
     * @param cooldownSeconds - The cooldown length.
     * @returns Whole seconds remaining, rounded up; 0 if already off cooldown.
     */
    getRemainingSeconds(streamerId: number, twitchUsername: string, cooldownSeconds: number): number {
      const elapsedMs = Date.now() - (lastClaimedAt.get(cooldownKey(streamerId, twitchUsername)) ?? 0);
      const remainingMs = cooldownSeconds * 1000 - elapsedMs;
      return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
    },

    /** Forgets every recorded claim (used by tests to avoid bleeding state between them). */
    clear(): void {
      lastClaimedAt.clear();
    },
  };
}
