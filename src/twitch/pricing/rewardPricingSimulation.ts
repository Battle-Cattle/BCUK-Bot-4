import { RewardPricingConfig, computePrice, decayDemand, computeRedemptionIncrement } from './rewardPricingMath';
import { PriceHistoryPoint } from '../../web/priceHistoryChart';

/** Config needed to simulate a full constant-usage ramp + cooldown cycle for one reward. */
export interface SimulationConfig extends RewardPricingConfig {
  cooldownSeconds: number;
  halfLifeSeconds: number;
  timeToMaxMultiplier: number;
}

/** Result of {@link simulateConstantUsageCycle}: the plotted curve plus its key milestones. */
export interface SimulationResult {
  /** Price/demand points across the whole cycle, `t` in ms elapsed since the ramp started at 0. */
  points: PriceHistoryPoint[];
  /** The demand reached at the ramp/cooldown transition — may be below 1 (see module docs). */
  peakDemand: number;
  /** Elapsed ms when the ramp phase ends and the cooldown phase begins. */
  peakAtMs: number;
  /** Elapsed ms of the last point (end of the cooldown phase). */
  totalDurationMs: number;
}

/**
 * Fraction of the way to the ramp's asymptote (or, for a config whose steady state clamps at 1,
 * how precisely the 1.0 crossing is targeted) / fraction of the peak the cooldown phase decays
 * down to before the simulation stops. Shared so the ramp-up and cooldown-back-down halves of the
 * chart read as symmetric "close enough to done" thresholds.
 */
const CONVERGENCE_RATIO = 0.01;
/** Points sampled across each phase's continuous curve. */
const SAMPLE_COUNT = 40;

/**
 * Simulates a reward's demand/price over one full cycle: constant redemptions at the reward's
 * own cooldown rate (i.e. redeeming the instant it's available, forever) ramping demand up from
 * 0, followed by a cooldown phase with no further redemptions decaying demand back down to ~0.
 *
 * The ramp phase does not necessarily reach 100% demand. Redeeming every `cooldownSeconds` with
 * decay in between follows the recurrence `d' = decay(d) + increment`, whose steady state is
 * `increment / (1 - decayPerCooldown)` — the continuous-time relaxation of that same recurrence is
 * `demand(t) = steadyState * (1 - 2^(-t/halfLife))`, which is what this function samples. That
 * only approaches (or, if the steady state is >= 1, actually reaches and clamps at) 100% demand;
 * for gentler configs it asymptotes below 100%. This function reports whatever the real ramp
 * peak is via `peakDemand` rather than assuming it always hits 100%.
 *
 * @param config - The reward's pricing config plus its cooldown and the streamer's half-life/time-to-max settings.
 * @returns The simulated points plus the demand/timing at the ramp-to-cooldown transition.
 */
export function simulateConstantUsageCycle(config: SimulationConfig): SimulationResult {
  const { cooldownSeconds, halfLifeSeconds, timeToMaxMultiplier } = config;
  const redemptionIncrement = computeRedemptionIncrement(cooldownSeconds, halfLifeSeconds, timeToMaxMultiplier);
  const decayPerCooldown = decayDemand(1, cooldownSeconds, halfLifeSeconds);
  const steadyStateDemand = redemptionIncrement / (1 - decayPerCooldown);

  // Continuous-time closed form for the ramp recurrence: demand(t) = steadyState * (1 - 2^(-t/halfLife)).
  const rampDemandAt = (tSeconds: number) => Math.min(1, steadyStateDemand * (1 - decayDemand(1, tSeconds, halfLifeSeconds)));

  // How long to draw the ramp for: the exact time it crosses 100% if the config drives it there,
  // otherwise the time it gets within CONVERGENCE_RATIO of its (sub-100%) asymptote.
  const rampDurationSeconds = steadyStateDemand > 1
    ? halfLifeSeconds * Math.log2(1 / (1 - 1 / steadyStateDemand))
    : halfLifeSeconds * Math.log2(1 / CONVERGENCE_RATIO);

  const points: PriceHistoryPoint[] = [];
  const pushPoint = (tMs: number, demand: number) => points.push({ t: tMs, cost: computePrice(demand, config) });

  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const tSeconds = (rampDurationSeconds * i) / SAMPLE_COUNT;
    pushPoint(tSeconds * 1000, rampDemandAt(tSeconds));
  }

  const peakAtMs = rampDurationSeconds * 1000;
  const peakDemand = rampDemandAt(rampDurationSeconds);

  if (peakDemand > CONVERGENCE_RATIO) {
    const cooldownDurationSeconds = halfLifeSeconds * Math.log2(1 / CONVERGENCE_RATIO);
    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const elapsedSeconds = (cooldownDurationSeconds * i) / SAMPLE_COUNT;
      pushPoint(peakAtMs + elapsedSeconds * 1000, decayDemand(peakDemand, elapsedSeconds, halfLifeSeconds));
    }
  }

  return {
    points,
    peakDemand,
    peakAtMs,
    totalDurationMs: points[points.length - 1].t,
  };
}
