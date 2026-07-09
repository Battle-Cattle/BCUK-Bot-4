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
  /** The price at `peakDemand` — `computePrice(peakDemand, config)`. */
  peakCost: number;
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
/** Points sampled across the cooldown phase's continuous decay curve. */
const SAMPLE_COUNT = 40;
/**
 * Hard ceiling on how many real cooldown-spaced redemptions the ramp is allowed to need before
 * it's considered "converged". Guards against a pathological config (a cooldown far shorter than
 * the half-life) blowing the ramp's time axis out to unreasonable real-world durations.
 */
const MAX_REDEMPTIONS = 5000;
/**
 * Max number of real redemptions ("teeth") actually drawn in the ramp phase. When there are more
 * real redemptions than this before convergence, they're subsampled evenly across the ramp so the
 * rendered sawtooth stays legible and the point count stays bounded — the last rendered tooth is
 * always the true peak.
 */
const MAX_RENDERED_TEETH = 50;

/**
 * Simulates a reward's demand/price over one full cycle: constant redemptions at the reward's
 * own cooldown rate (i.e. redeeming the instant it's available, forever) ramping demand up from
 * 0, followed by a cooldown phase with no further redemptions decaying demand back down to ~0.
 *
 * The ramp phase does not necessarily reach 100% demand, and it isn't smooth: real redemptions
 * only ever land on cooldown-spaced instants, so demand jumps up at each one and decays
 * continuously until the next — the recurrence `d_k = decay(d_{k-1}) + increment`, `d_{-1} = 0`.
 * That recurrence has the closed form `demandAfterRedemption(k) = steadyState * (1 -
 * decayPerCooldown^(k+1))`, where `steadyState = increment / (1 - decayPerCooldown)` is its fixed
 * point — this function samples that exact discrete trajectory (jump, then decay, repeat) rather
 * than smoothing over the cooldown-shaped teeth. The ramp only approaches (or, if the steady
 * state is >= 1, actually reaches and clamps at) 100% demand; for gentler configs it asymptotes
 * below 100%. This function reports whatever the real ramp peak is via `peakDemand` rather than
 * assuming it always hits 100%.
 *
 * @param config - The reward's pricing config plus its cooldown and the streamer's half-life/time-to-max settings.
 * @returns The simulated points plus the demand/timing at the ramp-to-cooldown transition.
 */
export function simulateConstantUsageCycle(config: SimulationConfig): SimulationResult {
  const { cooldownSeconds, halfLifeSeconds, timeToMaxMultiplier } = config;
  const redemptionIncrement = computeRedemptionIncrement(cooldownSeconds, halfLifeSeconds, timeToMaxMultiplier);
  const decayPerCooldown = decayDemand(1, cooldownSeconds, halfLifeSeconds);
  const steadyStateDemand = redemptionIncrement / (1 - decayPerCooldown);

  // Closed form for the ramp recurrence (see module docs): demand right after the (k+1)-th
  // redemption (0-indexed) is steadyState * (1 - decayPerCooldown^(k+1)).
  const demandAfterRedemption = (k: number) => Math.min(1, steadyStateDemand * (1 - Math.pow(decayPerCooldown, k + 1)));

  // How many redemptions the ramp needs: the exact count that clamps demand at 100% if the
  // config drives it there, otherwise the count that gets within CONVERGENCE_RATIO of the
  // (sub-100%) steady state.
  const rawRedemptionsNeeded = steadyStateDemand > 1
    ? Math.log(1 - 1 / steadyStateDemand) / Math.log(decayPerCooldown)
    : Math.log(CONVERGENCE_RATIO) / Math.log(decayPerCooldown);
  const redemptionCount = Math.min(MAX_REDEMPTIONS, Math.max(1, Math.ceil(rawRedemptionsNeeded)));

  const peakAtMs = (redemptionCount - 1) * cooldownSeconds * 1000;
  const peakDemand = demandAfterRedemption(redemptionCount - 1);
  const peakCost = computePrice(peakDemand, config);

  const points: PriceHistoryPoint[] = [];
  const pushPoint = (tMs: number, demand: number) => points.push({ t: tMs, cost: computePrice(demand, config) });

  // Baseline before the very first redemption fires — skipped when the peak is already reached
  // at t=0 (first redemption immediately clamps demand), so it doesn't collide with the peak point.
  if (peakAtMs > 0) pushPoint(0, 0);

  const teethToRender = Math.min(redemptionCount, MAX_RENDERED_TEETH);
  for (let i = 0; i < teethToRender; i++) {
    const k = teethToRender === 1 ? redemptionCount - 1 : Math.round((i * (redemptionCount - 1)) / (teethToRender - 1));
    const redemptionAtMs = k * cooldownSeconds * 1000;
    const jumpDemand = demandAfterRedemption(k);
    pushPoint(redemptionAtMs, jumpDemand);

    if (k < redemptionCount - 1) {
      // Decay from this redemption until just before the next one. Nudged 1ms earlier when that
      // would otherwise land exactly on peakAtMs (the tooth immediately before the final one),
      // so it doesn't get swept into the cooldown phase's "monotonically decreasing" points.
      const decayAtMs = redemptionAtMs + cooldownSeconds * 1000;
      pushPoint(decayAtMs === peakAtMs ? decayAtMs - 1 : decayAtMs, decayDemand(jumpDemand, cooldownSeconds, halfLifeSeconds));
    }
  }

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
    peakCost,
    peakAtMs,
    totalDurationMs: points[points.length - 1].t,
  };
}
