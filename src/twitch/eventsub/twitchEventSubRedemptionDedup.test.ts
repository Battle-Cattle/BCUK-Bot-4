import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDuplicateRedemption,
  purgeExpiredRedemptionIds,
  markRedemptionHandled,
  clearPendingRedemption,
  seenRedemptionIds,
  pendingRedemptionIds,
  REDEMPTION_DEDUP_TTL_MS,
} from './twitchEventSubRedemptionDedup';

beforeEach(() => {
  seenRedemptionIds.clear();
  pendingRedemptionIds.clear();
});

// ---------------------------------------------------------------------------
// isDuplicateRedemption
// ---------------------------------------------------------------------------
describe('isDuplicateRedemption', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false on first call with a given redemption ID', () => {
    expect(isDuplicateRedemption('redemption-unique-1')).toBe(false);
  });

  it('returns true on second call with the same redemption ID while still pending', () => {
    isDuplicateRedemption('redemption-dup-1');
    expect(isDuplicateRedemption('redemption-dup-1')).toBe(true);
  });

  it('returns false again after TTL has expired for a completed redemption', () => {
    isDuplicateRedemption('redemption-expired-1');
    markRedemptionHandled('redemption-expired-1');
    vi.advanceTimersByTime(REDEMPTION_DEDUP_TTL_MS + 1);
    expect(isDuplicateRedemption('redemption-expired-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredRedemptionIds
// ---------------------------------------------------------------------------
describe('purgeExpiredRedemptionIds', () => {
  it('removes only entries past their expiry', () => {
    seenRedemptionIds.set('expired', Date.now() - 1);
    seenRedemptionIds.set('live', Date.now() + REDEMPTION_DEDUP_TTL_MS);

    purgeExpiredRedemptionIds();

    expect(seenRedemptionIds.has('expired')).toBe(false);
    expect(seenRedemptionIds.has('live')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pending-vs-completed lifecycle (markRedemptionHandled / clearPendingRedemption)
// ---------------------------------------------------------------------------
describe('pending redemption lifecycle', () => {
  it('treats an in-flight (pending) redemption id as a duplicate', () => {
    expect(isDuplicateRedemption('redemption-pending-1')).toBe(false);
    expect(isDuplicateRedemption('redemption-pending-1')).toBe(true);
  });

  it('lets a later attempt proceed after clearPendingRedemption releases a failed claim', () => {
    isDuplicateRedemption('redemption-retry-1');
    clearPendingRedemption('redemption-retry-1');

    expect(isDuplicateRedemption('redemption-retry-1')).toBe(false);
  });

  it('marks a successfully handled redemption as a genuine duplicate within the TTL', () => {
    vi.useFakeTimers();
    try {
      isDuplicateRedemption('redemption-success-1');
      markRedemptionHandled('redemption-success-1');

      expect(pendingRedemptionIds.has('redemption-success-1')).toBe(false);
      expect(isDuplicateRedemption('redemption-success-1')).toBe(true);

      vi.advanceTimersByTime(REDEMPTION_DEDUP_TTL_MS + 1);
      expect(isDuplicateRedemption('redemption-success-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
