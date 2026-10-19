import { describe, it, expect } from 'vitest';
import { ACK_MAX_HOLD_MS, ackTimerDelayMs, canExtendAckHold } from './ackHold';

describe('canExtendAckHold', () => {
  it('allows extending until the event has been held for ACK_MAX_HOLD_MS', () => {
    expect(canExtendAckHold(1_000, 1_000)).toBe(true);
    expect(canExtendAckHold(1_000, 1_000 + ACK_MAX_HOLD_MS - 1)).toBe(true);
    expect(canExtendAckHold(1_000, 1_000 + ACK_MAX_HOLD_MS)).toBe(false);
  });

  it('holds for longer than the longest single Delay action a companion app allows (1 hour)', () => {
    expect(ACK_MAX_HOLD_MS).toBeGreaterThan(60 * 60_000);
  });
});

describe('ackTimerDelayMs', () => {
  it('runs the full timeout while the hold has room for it', () => {
    expect(ackTimerDelayMs(180_000, 1_000, 1_000)).toBe(180_000);
  });

  it('cuts the timer short so the event expires at the hold boundary, never past it', () => {
    expect(ackTimerDelayMs(180_000, 1_000, 1_000 + ACK_MAX_HOLD_MS - 5_000)).toBe(5_000);
    expect(ackTimerDelayMs(180_000, 1_000, 1_000 + ACK_MAX_HOLD_MS + 5_000)).toBe(0);
  });
});
