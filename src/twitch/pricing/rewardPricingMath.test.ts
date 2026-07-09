import { describe, it, expect } from 'vitest';
import { computePrice, decayDemand, applyRedemption, computeRedemptionIncrement } from './rewardPricingMath';

const config = { baseCost: 200, maxMultiplier: 4, curve: 1.5 };

describe('computePrice', () => {
  it('returns baseCost at demand=0', () => {
    expect(computePrice(0, config)).toBe(200);
  });

  it('returns baseCost * (1 + maxMultiplier) at demand=1', () => {
    expect(computePrice(1, config)).toBe(1000);
  });

  it('computes a curved mid-range value', () => {
    // usage=0.5, curve=1.5 -> curved = 0.5^1.5 ≈ 0.353553
    // price = round(200 * (1 + 0.353553*4)) = round(200 * 2.414214) = round(482.8427) = 483
    expect(computePrice(0.5, config)).toBe(483);
  });

  it('rounds to the nearest integer', () => {
    const c = { baseCost: 100, maxMultiplier: 1, curve: 1 };
    // usage=0.006 -> price = round(100 * 1.006) = round(100.6) = 101
    expect(computePrice(0.006, c)).toBe(101);
  });

  it('clamps demand above 1 before computing', () => {
    expect(computePrice(5, config)).toBe(computePrice(1, config));
  });

  it('clamps demand below 0 before computing', () => {
    expect(computePrice(-5, config)).toBe(computePrice(0, config));
  });

  it('rounds to the nearest multiple of roundToNearest when set', () => {
    // usage=0.5, curve=1.5 -> raw = 200 * 2.414214 = 482.8427 -> nearest 10 = 480
    expect(computePrice(0.5, { ...config, roundToNearest: 10 })).toBe(480);
    // nearest 5 = 485
    expect(computePrice(0.5, { ...config, roundToNearest: 5 })).toBe(485);
  });

  it('is unaffected by roundToNearest when it is 0', () => {
    expect(computePrice(0.5, { ...config, roundToNearest: 0 })).toBe(computePrice(0.5, config));
  });

  it('is unaffected by roundToNearest when it is negative', () => {
    expect(computePrice(0.5, { ...config, roundToNearest: -5 })).toBe(computePrice(0.5, config));
  });

  it('is unaffected by a missing roundToNearest', () => {
    expect(computePrice(0.5, config)).toBe(483);
  });
});

describe('decayDemand', () => {
  it('returns demand unchanged when elapsedSeconds is 0', () => {
    expect(decayDemand(0.8, 0, 1800)).toBe(0.8);
  });

  it('halves demand exactly after one half-life', () => {
    expect(decayDemand(0.8, 1800, 1800)).toBeCloseTo(0.4, 10);
  });

  it('quarters demand after two half-lives', () => {
    expect(decayDemand(0.8, 3600, 1800)).toBeCloseTo(0.2, 10);
  });

  it('clamps to 0 for very large elapsed time', () => {
    expect(decayDemand(1, 1e9, 1800)).toBe(0);
  });

  it('never goes negative', () => {
    expect(decayDemand(0, 1000, 1800)).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op when elapsedSeconds is negative (clock skew)', () => {
    expect(decayDemand(0.5, -10, 1800)).toBe(0.5);
  });

  it('is a no-op when halfLifeSeconds is non-positive', () => {
    expect(decayDemand(0.5, 100, 0)).toBe(0.5);
  });

  it('still clamps an out-of-range demand even in the no-op path', () => {
    expect(decayDemand(1.5, 0, 1800)).toBe(1);
    expect(decayDemand(-1.5, 0, 1800)).toBe(0);
  });
});

describe('computeRedemptionIncrement', () => {
  it('matches the documented example: 10-min cooldown, 30-min half-life, x2 multiplier -> 1/6 demand per redemption', () => {
    expect(computeRedemptionIncrement(600, 1800, 2)).toBeCloseTo(1 / 6, 10);
  });

  it('scales linearly with cooldown', () => {
    expect(computeRedemptionIncrement(1200, 1800, 2)).toBeCloseTo(1 / 3, 10);
  });

  it('scales inversely with the time-to-max multiplier', () => {
    expect(computeRedemptionIncrement(600, 1800, 4)).toBeCloseTo(1 / 12, 10);
  });

  it('scales inversely with half-life', () => {
    expect(computeRedemptionIncrement(600, 3600, 2)).toBeCloseTo(1 / 12, 10);
  });
});

describe('applyRedemption', () => {
  it('decays then adds the redemption increment', () => {
    // decay(0.8, 600, 1800) = 0.8 * 2^(-600/1800) = 0.8 * 2^(-1/3) ≈ 0.635200
    const result = applyRedemption(0.8, 600, 1800, 0.1);
    expect(result).toBeCloseTo(0.6352 + 0.1, 3);
  });

  it('clamps to 1 when the result would overflow', () => {
    expect(applyRedemption(0.95, 0, 1800, 0.5)).toBe(1);
  });

  it('applies decay before the increment (order matters)', () => {
    // If increment were applied before decay, elapsed=huge would still decay demand+increment to ~0.
    // Applying decay first means the increment survives even after demand fully decays.
    const result = applyRedemption(1, 1e9, 1800, 0.2);
    expect(result).toBeCloseTo(0.2, 10);
  });
});
