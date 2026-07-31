import { GLOBAL_COOLDOWN_MS } from '../shared/config';

/** A per-key cooldown gate: `tryClaim` throttles, `forget` drops a key's recorded claim time. */
export interface CooldownGate {
  tryClaim(key: string): boolean;
  forget(key: string): void;
}

/**
 * Creates an independent per-key cooldown gate backed by `GLOBAL_COOLDOWN_MS`. Used to
 * throttle the custom-command and counter-trigger chat handlers per guild/channel, mirroring
 * the per-guild cooldown `commandRouter.ts` already applies to SFX triggers — without it, any
 * unprivileged chat member can spam a matching message as fast as they can send it.
 */
export function createCooldownGate(): CooldownGate {
  const lastClaimedAt = new Map<string, number>();

  return {
    /**
     * Returns true and records `now` for `key` if it is off cooldown; returns false — leaving
     * the recorded time untouched — if a previous claim for `key` is still within the window.
     */
    tryClaim(key: string): boolean {
      const now = Date.now();
      const last = lastClaimedAt.get(key) ?? 0;
      if (now - last < GLOBAL_COOLDOWN_MS) return false;
      lastClaimedAt.set(key, now);
      return true;
    },

    /** Forgets `key`'s recorded claim time. Safe to call for a key with no state (no-op). */
    forget(key: string): void {
      lastClaimedAt.delete(key);
    },
  };
}
