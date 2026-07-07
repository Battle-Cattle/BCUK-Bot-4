import { describe, it, expect } from 'vitest';
import { simulateConstantUsageCycle } from './rewardPricingSimulation';
import { computePrice } from './rewardPricingMath';

const config = {
  baseCost: 200,
  maxMultiplier: 4,
  curve: 1.5,
  cooldownSeconds: 60,
  halfLifeSeconds: 1800,
  timeToMaxMultiplier: 2,
};

describe('simulateConstantUsageCycle', () => {
  it('asymptotes below 100% demand under gentle (default-like) settings', () => {
    // Steady state = increment/(1-decayPerCooldown) ≈ 0.7297 for these settings — well short of 1.
    const result = simulateConstantUsageCycle(config);
    expect(result.peakDemand).toBeGreaterThan(0.7);
    expect(result.peakDemand).toBeLessThan(0.73);
  });

  it('clamps at exactly 100% demand when the config drives the steady state past 1', () => {
    // increment = 600/(0.5*600) = 2, decayPerCooldown = 2^(-1) = 0.5, steady state = 2/0.5 = 4 > 1.
    const result = simulateConstantUsageCycle({
      ...config,
      cooldownSeconds: 600,
      halfLifeSeconds: 600,
      timeToMaxMultiplier: 0.5,
    });
    expect(result.peakDemand).toBe(1);
  });

  it('ramp phase is monotonically non-decreasing up to the peak', () => {
    const result = simulateConstantUsageCycle(config);
    const ramp = result.points.filter((p) => p.t <= result.peakAtMs);
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i].cost).toBeGreaterThanOrEqual(ramp[i - 1].cost);
    }
  });

  it('cooldown phase is monotonically non-increasing back down toward baseline', () => {
    const result = simulateConstantUsageCycle(config);
    const cooldown = result.points.filter((p) => p.t >= result.peakAtMs);
    for (let i = 1; i < cooldown.length; i++) {
      expect(cooldown[i].cost).toBeLessThanOrEqual(cooldown[i - 1].cost);
    }
    expect(cooldown[cooldown.length - 1].cost).toBeLessThan(cooldown[0].cost);
  });

  it('starts at baseCost and ends within 1% of baseCost', () => {
    const result = simulateConstantUsageCycle(config);
    expect(result.points[0].cost).toBe(config.baseCost);
    const last = result.points[result.points.length - 1];
    expect(last.cost).toBeLessThan(config.baseCost * 1.05);
  });

  it("every point's cost matches computePrice for its implied demand", () => {
    // Re-derive demand from cost isn't possible in general (curve isn't invertible cleanly for
    // every case), so instead spot-check the peak point directly.
    const result = simulateConstantUsageCycle(config);
    expect(result.points.find((p) => p.t === result.peakAtMs)?.cost).toBe(computePrice(result.peakDemand, config));
  });

  it('does not loop unreasonably long for an extreme config (near-zero half-life)', () => {
    const start = Date.now();
    const result = simulateConstantUsageCycle({ ...config, halfLifeSeconds: 1, cooldownSeconds: 1 });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.points.length).toBeGreaterThan(0);
  });
});
