import { describe, it, expect } from 'vitest';
import { computePrice, decayDemand, applyRedemption } from './rewardPricingMath';

const config = { baseCost: 200, cooldownSeconds: 300, maxMultiplier: 4, curve: 1.5 };

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
    const c = { baseCost: 100, cooldownSeconds: 60, maxMultiplier: 1, curve: 1 };
    // usage=0.006 -> price = round(100 * 1.006) = round(100.6) = 101
    expect(computePrice(0.006, c)).toBe(101);
  });

  it('clamps demand above 1 before computing', () => {
    expect(computePrice(5, config)).toBe(computePrice(1, config));
  });

  it('clamps demand below 0 before computing', () => {
    expect(computePrice(-5, config)).toBe(computePrice(0, config));
  });
});

describe('decayDemand', () => {
  it('returns demand unchanged when elapsedSeconds is 0', () => {
    expect(decayDemand(0.8, 0, 300, 3)).toBe(0.8);
  });

  it('halves demand exactly after one half-life worth of periods', () => {
    // elapsedSeconds = cooldownSeconds * decayHalfLifePeriods -> periodsElapsed = decayHalfLifePeriods
    const result = decayDemand(0.8, 300 * 3, 300, 3);
    expect(result).toBeCloseTo(0.4, 10);
  });

  it('quarters demand after two half-lives worth of periods', () => {
    const result = decayDemand(0.8, 300 * 6, 300, 3);
    expect(result).toBeCloseTo(0.2, 10);
  });

  it('clamps to 0 for very large elapsed time', () => {
    expect(decayDemand(1, 1e9, 300, 3)).toBe(0);
  });

  it('never goes negative', () => {
    expect(decayDemand(0, 1000, 300, 3)).toBeGreaterThanOrEqual(0);
  });

  it('is a no-op when elapsedSeconds is negative (clock skew)', () => {
    expect(decayDemand(0.5, -10, 300, 3)).toBe(0.5);
  });

  it('is a no-op when cooldownSeconds is non-positive', () => {
    expect(decayDemand(0.5, 100, 0, 3)).toBe(0.5);
  });

  it('is a no-op when decayHalfLifePeriods is non-positive', () => {
    expect(decayDemand(0.5, 100, 300, 0)).toBe(0.5);
  });

  it('still clamps an out-of-range demand even in the no-op path', () => {
    expect(decayDemand(1.5, 0, 300, 3)).toBe(1);
    expect(decayDemand(-1.5, 0, 300, 3)).toBe(0);
  });
});

describe('applyRedemption', () => {
  it('decays then adds the redemption increment', () => {
    // decay(0.8, 300, 300, 3) ≈ 0.8 * 2^(-1/3) ≈ 0.635200
    const result = applyRedemption(0.8, 300, 300, 3, 0.1);
    expect(result).toBeCloseTo(0.6352 + 0.1, 3);
  });

  it('clamps to 1 when the result would overflow', () => {
    expect(applyRedemption(0.95, 0, 300, 3, 0.5)).toBe(1);
  });

  it('applies decay before the increment (order matters)', () => {
    // If increment were applied before decay, elapsed=huge would still decay demand+increment to ~0.
    // Applying decay first means the increment survives even after demand fully decays.
    const result = applyRedemption(1, 1e9, 300, 3, 0.2);
    expect(result).toBeCloseTo(0.2, 10);
  });
});

describe('cooldown normalization — comparable rates across different cooldowns', () => {
  it('two rewards with different cooldowns redeemed at their own max frequency converge to the same steady-state demand', () => {
    const decayHalfLifePeriods = 3;
    const redemptionIncrement = 0.1;

    function simulate(cooldownSeconds: number, iterations: number): number {
      let demand = 0;
      for (let i = 0; i < iterations; i++) {
        demand = applyRedemption(demand, cooldownSeconds, cooldownSeconds, decayHalfLifePeriods, redemptionIncrement);
      }
      return demand;
    }

    const shortCooldown = simulate(30, 200);
    const longCooldown = simulate(300, 200);

    expect(Math.abs(shortCooldown - longCooldown)).toBeLessThan(1e-6);

    const r = Math.pow(2, -1 / decayHalfLifePeriods);
    const expectedSteadyState = redemptionIncrement / (1 - r);
    expect(shortCooldown).toBeCloseTo(Math.min(1, expectedSteadyState), 6);
  });
});
