// Startup sweep shared by the companion-acknowledgement ledgers (advanced-command uses and
// channel-point redemptions): anything still pending when the bot starts lost its in-memory
// acknowledgement timer in the restart, so it's refunded.

/** What one ledger plugs into {@link sweepPendingAcks}. */
export interface PendingAckSweep {
  /** Ids still pending in the ledger. */
  pendingIds: string[];
  /** True if the id already has a live timer in this process (so it isn't stale). */
  isTracked: (id: string) => boolean;
  /** Refunds one id; resolves true if this call resolved it. */
  refund: (id: string) => Promise<boolean>;
  /** Called when a refund throws, to log it and schedule a retry. */
  onFailure: (id: string, err: unknown) => void;
}

/**
 * Refunds every pending id that has no live timer. One failed refund doesn't hold back the rest:
 * it goes to `onFailure` (which retries it later) and the sweep carries on.
 * @param sweep - The ledger's pending ids and callbacks.
 * @returns How many ids this sweep resolved.
 */
export async function sweepPendingAcks(sweep: PendingAckSweep): Promise<number> {
  let resolved = 0;
  for (const id of sweep.pendingIds) {
    if (sweep.isTracked(id)) continue;
    try {
      if (await sweep.refund(id)) resolved++;
    } catch (err) {
      sweep.onFailure(id, err);
    }
  }
  return resolved;
}
