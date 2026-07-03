/** Per-reward pricing parameters used by the price/demand calculations below. */
export interface RewardPricingConfig {
  baseCost: number;
  cooldownSeconds: number;
  maxMultiplier: number;
  curve: number;
}

/**
 * Computes the current redemption price from demand and a reward's pricing config.
 * price = round(baseCost * (1 + clamp(demand,0,1)^curve * maxMultiplier)).
 *
 * @param demand - Current demand value; clamped to [0,1] before use.
 * @param config - The reward's pricing configuration.
 * @returns The rounded price, bounded to [baseCost, baseCost*(1+maxMultiplier)].
 */
export function computePrice(demand: number, config: RewardPricingConfig): number {
  const usage = Math.min(1, Math.max(0, demand));
  const curved = Math.pow(usage, config.curve);
  return Math.round(config.baseCost * (1 + curved * config.maxMultiplier));
}

/**
 * Decays demand continuously over elapsed time, normalized by the reward's own cooldown
 * so rewards with different cooldowns decay at comparable relative rates. Guards against
 * non-positive cooldown/half-life or negative elapsed time by treating them as a no-op
 * rather than throwing or producing NaN/Infinity.
 *
 * @param demand - Demand value before decay.
 * @param elapsedSeconds - Real seconds elapsed since the demand value was last updated.
 * @param cooldownSeconds - The reward's configured cooldown, used to normalize elapsed time.
 * @param decayHalfLifePeriods - Global setting: number of cooldown-periods for demand to halve.
 * @returns The decayed demand, clamped to [0,1].
 */
export function decayDemand(
  demand: number,
  elapsedSeconds: number,
  cooldownSeconds: number,
  decayHalfLifePeriods: number,
): number {
  if (elapsedSeconds <= 0 || cooldownSeconds <= 0 || decayHalfLifePeriods <= 0) {
    return Math.min(1, Math.max(0, demand));
  }
  const periodsElapsed = elapsedSeconds / cooldownSeconds;
  const decayed = demand * Math.pow(2, -periodsElapsed / decayHalfLifePeriods);
  return Math.min(1, Math.max(0, decayed));
}

/**
 * Applies a single redemption to demand: first decays for elapsed time, then adds the
 * global redemption increment, then clamps to [0,1].
 *
 * @param demand - Demand value before this redemption.
 * @param elapsedSeconds - Real seconds elapsed since the demand value was last updated.
 * @param cooldownSeconds - The reward's configured cooldown, used to normalize decay.
 * @param decayHalfLifePeriods - Global setting: number of cooldown-periods for demand to halve.
 * @param redemptionIncrement - Global setting: flat demand increase applied per redemption.
 * @returns The updated demand, clamped to [0,1].
 */
export function applyRedemption(
  demand: number,
  elapsedSeconds: number,
  cooldownSeconds: number,
  decayHalfLifePeriods: number,
  redemptionIncrement: number,
): number {
  const decayed = decayDemand(demand, elapsedSeconds, cooldownSeconds, decayHalfLifePeriods);
  return Math.min(1, Math.max(0, decayed + redemptionIncrement));
}
