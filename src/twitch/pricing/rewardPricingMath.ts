/** Per-reward pricing parameters used by {@link computePrice}. */
export interface RewardPricingConfig {
  baseCost: number;
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
 * Decays demand continuously over elapsed time against a fixed half-life — demand halves every
 * `halfLifeSeconds` of inactivity, the same for every reward regardless of its own cooldown.
 * Guards against a non-positive half-life or negative elapsed time by treating them as a no-op
 * rather than throwing or producing NaN/Infinity.
 *
 * @param demand - Demand value before decay.
 * @param elapsedSeconds - Real seconds elapsed since the demand value was last updated.
 * @param halfLifeSeconds - Streamer's configured half-life, in seconds.
 * @returns The decayed demand, clamped to [0,1].
 */
export function decayDemand(
  demand: number,
  elapsedSeconds: number,
  halfLifeSeconds: number,
): number {
  if (elapsedSeconds <= 0 || halfLifeSeconds <= 0) {
    return Math.min(1, Math.max(0, demand));
  }
  const decayed = demand * Math.pow(2, -elapsedSeconds / halfLifeSeconds);
  return Math.min(1, Math.max(0, decayed));
}

/**
 * Computes the flat demand increase applied for a single redemption of a reward with the given
 * cooldown: redeeming at that reward's own maximum frequency (i.e. every `cooldownSeconds`,
 * ignoring decay) reaches 100% demand after `timeToMaxMultiplier` half-lives worth of time.
 * E.g. a 10-minute cooldown with a 30-minute half-life and `timeToMaxMultiplier=2` (60 minutes
 * to reach max) adds 10/60 = 1/6 demand per redemption.
 *
 * @param cooldownSeconds - The reward's own cooldown, in seconds.
 * @param halfLifeSeconds - Streamer's configured half-life, in seconds.
 * @param timeToMaxMultiplier - Streamer's configured "time to 100% demand", expressed as a
 *   multiple of the half-life.
 */
export function computeRedemptionIncrement(
  cooldownSeconds: number,
  halfLifeSeconds: number,
  timeToMaxMultiplier: number,
): number {
  return cooldownSeconds / (timeToMaxMultiplier * halfLifeSeconds);
}

/**
 * Applies a single redemption to demand: first decays for elapsed time, then adds
 * `redemptionIncrement`, then clamps to [0,1].
 *
 * @param demand - Demand value before this redemption.
 * @param elapsedSeconds - Real seconds elapsed since the demand value was last updated.
 * @param halfLifeSeconds - Streamer's configured half-life, in seconds.
 * @param redemptionIncrement - Flat demand increase for this redemption (see {@link computeRedemptionIncrement}).
 * @returns The updated demand, clamped to [0,1].
 */
export function applyRedemption(
  demand: number,
  elapsedSeconds: number,
  halfLifeSeconds: number,
  redemptionIncrement: number,
): number {
  const decayed = decayDemand(demand, elapsedSeconds, halfLifeSeconds);
  return Math.min(1, Math.max(0, decayed + redemptionIncrement));
}
