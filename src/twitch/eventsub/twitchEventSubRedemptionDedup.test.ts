import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isDuplicateRedemption, purgeExpiredRedemptionIds, seenRedemptionIds, REDEMPTION_DEDUP_TTL_MS } from './twitchEventSubRedemptionDedup';

beforeEach(() => {
  seenRedemptionIds.clear();
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

  it('returns true on second call with the same redemption ID', () => {
    isDuplicateRedemption('redemption-dup-1');
    expect(isDuplicateRedemption('redemption-dup-1')).toBe(true);
  });

  it('returns false again after TTL has expired', () => {
    isDuplicateRedemption('redemption-expired-1');
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
