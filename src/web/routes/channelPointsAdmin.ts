import { createLogger } from '../../shared/logger';
import { Router } from 'express';
import { csrfProtection } from '../csrf';
import { requireAuth } from '../middleware';
import { getStreamerByDiscordId } from '../../db';
import type { DbStreamerEventSub } from '../../db';
import { getPricingConfigsForStreamer, getPricingSettingsForStreamer, getPricingHistory } from '../../db';
import type { RewardPricingRow, StreamerPricingSettings } from '../../db';
import { getCustomRewards, TwitchCustomReward } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/eventsub/twitchApiEventSub';
import { hasAuthFailedSubs } from '../../twitch/eventsub/twitchEventSubSubscriptions';
import { computePrice } from '../../twitch/pricing/rewardPricingMath';
import { simulateConstantUsageCycle } from '../../twitch/pricing/rewardPricingSimulation';
import { renderPriceHistoryChart } from '../priceHistoryChart';
import { filterQueryParam, renderError, renderView } from './shared';
import { router as channelPointsMutationsRouter } from './channelPointsAdminMutations';
import channelPointsEventsRouter from './channelPointsEvents';

const log = createLogger('ChannelPointsAdmin');
const router = Router();

const KNOWN_ERRORS = new Set([
  'not_a_streamer', 'invalid_reward_id', 'invalid_config', 'save_failed',
  'delete_failed', 'invalid_settings', 'invalid_reward_fields', 'create_failed', 'update_failed',
]);
const KNOWN_SUCCESSES = new Set([
  'pricing_saved', 'pricing_deleted', 'pricing_settings_saved', 'reward_created', 'reward_updated', 'reward_deleted',
]);

/** Selectable "last N hours" ranges for the price history chart; streams here typically run ~3h. */
const HISTORY_HOUR_OPTIONS = [1, 2, 3, 6, 9, 12, 24] as const;
const DEFAULT_HISTORY_HOURS = 3;

/** One row on the Channel Points page: a live Twitch reward, an "unlinked" orphaned pricing config, or both merged. */
interface ChannelPointRewardRow {
  rewardId: string;
  twitchReward: TwitchCustomReward | null;
  config: RewardPricingRow | null;
  previewPrice: number | null;
  /** Rendered SVG history chart, or null when there's no config to chart yet. */
  historyChart: string | null;
  /** Rendered SVG chart simulating a constant-use ramp-to-peak-demand-then-cooldown cycle, or null when there's no config to simulate yet. */
  simulationChart: string | null;
  /** One-line human-readable summary of the simulation's peak demand/price and phase durations, or null alongside a null `simulationChart`. */
  simulationSummary: string | null;
}

/** Formats a duration in ms as e.g. "1h 24m" or "12m", for the simulation summary sentence. */
function formatDurationShort(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Simulates a reward's demand/price over one constant-use ramp + cooldown cycle and renders it
 * as an SVG chart alongside a one-line summary of the peak reached and how long each phase takes —
 * this is illustrative (not real usage data), so admins can see how their base cost/multiplier/
 * curve/cooldown and the streamer's half-life/time-to-max settings shape the pricing curve.
 */
function buildSimulationChart(config: RewardPricingRow, settings: StreamerPricingSettings): { chart: string; summary: string } {
  const result = simulateConstantUsageCycle({
    baseCost: config.base_cost,
    maxMultiplier: config.max_multiplier,
    curve: config.curve,
    roundToNearest: config.round_to_nearest,
    cooldownSeconds: config.cooldown_seconds,
    halfLifeSeconds: settings.half_life_seconds,
    timeToMaxMultiplier: settings.time_to_max_multiplier,
  });

  const chart = renderPriceHistoryChart(result.points, 0, result.totalDurationMs, {
    elapsedTimeAxis: true,
    ariaLabel: `Simulated constant-use cycle peaking at ${(result.peakDemand * 100).toFixed(0)}% demand, ${result.peakCost} points, then cooling down`,
  });

  const summary = `Simulated: constant redemptions peak at ${(result.peakDemand * 100).toFixed(1)}% demand `
    + `(${result.peakCost.toLocaleString()} pts) after ~${formatDurationShort(result.peakAtMs)} of continuous use, `
    + `then cool back down over ~${formatDurationShort(result.totalDurationMs - result.peakAtMs)}.`;

  return { chart, summary };
}

/** Parses the `hours` query param against the allowed range options, defaulting when missing/invalid. */
function parseHistoryHours(value: unknown): number {
  const n = Number(value);
  return (HISTORY_HOUR_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_HISTORY_HOURS;
}

/** Computes the live preview price for a reward's current demand, from its pricing config. */
function previewPriceFor(config: RewardPricingRow): number {
  return computePrice(config.demand, {
    baseCost: config.base_cost,
    maxMultiplier: config.max_multiplier,
    curve: config.curve,
    roundToNearest: config.round_to_nearest,
  });
}

/** Fetches the streamer's live Twitch custom rewards, or an empty list if not connected or on any failure. */
async function fetchTwitchRewards(streamer: DbStreamerEventSub): Promise<TwitchCustomReward[]> {
  if (!streamer.twitch_user_id) return [];
  try {
    const token = await getValidToken(streamer);
    if (!token) return [];
    return await getCustomRewards(streamer.twitch_user_id, token);
  } catch (err) {
    log.warn('Failed to fetch Twitch custom rewards:', err);
    return [];
  }
}

/**
 * GET /channel-points — renders the Channel Points management page: the streamer's live
 * Twitch rewards (creatable/editable/deletable from here) merged with any existing dynamic
 * pricing config (including a live price preview and a price history chart over the selected
 * time range), and the streamer's own pricing decay-half-life/time-to-max settings.
 * Shows a reconnect prompt instead of the reward list when the streamer isn't connected, or
 * their connection has started failing with an auth error (mirrors the same check on
 * `/user/settings`).
 * @param req - Express request; reads `req.session.user`, `error`, `success`, and `hours` query params.
 * @param res - Express response; renders the `channelPointsAdmin` view, or a 500 error page on failure.
 */
router.get('/', requireAuth, csrfProtection, async (req, res) => {
  try {
    const streamer = await getStreamerByDiscordId(req.session.user!.discordId);
    const isConnected = !!streamer?.eventsub_access_token;
    const needsReconnect = isConnected && !!streamer?.twitch_name && hasAuthFailedSubs(streamer.twitch_name);

    const [pricingConfigs, twitchRewards, pricingSettings] = streamer && isConnected && !needsReconnect
      ? await Promise.all([getPricingConfigsForStreamer(streamer.id), fetchTwitchRewards(streamer), getPricingSettingsForStreamer(streamer.id)])
      : [[], [], null];

    const historyHours = parseHistoryHours(req.query.hours);
    const rangeEndMs = Date.now();
    const rangeStartMs = rangeEndMs - historyHours * 60 * 60 * 1000;

    async function buildHistoryChart(config: RewardPricingRow): Promise<string> {
      const points = await getPricingHistory(config.id, rangeStartMs);
      return renderPriceHistoryChart(points.map((p) => ({ t: Number(p.recorded_at), cost: p.cost })), rangeStartMs, rangeEndMs);
    }

    // Only ever called for a config drawn from `pricingConfigs`, which is populated in the same
    // branch as `pricingSettings` above — so `pricingSettings` is guaranteed non-null here.
    function buildSimulation(config: RewardPricingRow): { simulationChart: string; simulationSummary: string } {
      const { chart, summary } = buildSimulationChart(config, pricingSettings!);
      return { simulationChart: chart, simulationSummary: summary };
    }

    const configByRewardId = new Map(pricingConfigs.map((c) => [c.twitch_reward_id, c]));
    const matchedRewardIds = new Set(twitchRewards.map((tr) => tr.id));

    const rewards: ChannelPointRewardRow[] = await Promise.all(twitchRewards.map(async (tr) => {
      const config = configByRewardId.get(tr.id) ?? null;
      return {
        rewardId: tr.id,
        twitchReward: tr,
        config,
        previewPrice: config ? previewPriceFor(config) : null,
        historyChart: config ? await buildHistoryChart(config) : null,
        ...(config ? buildSimulation(config) : { simulationChart: null, simulationSummary: null }),
      };
    }));

    // Configs whose reward no longer appears on Twitch (deleted, or the streamer's token
    // lacks the scope to list it) still get processed by the decay scheduler — surface them
    // as "unlinked" rows so they aren't invisible/unmanageable from this page.
    const unlinkedRows = await Promise.all(
      pricingConfigs
        .filter((config) => !matchedRewardIds.has(config.twitch_reward_id))
        .map(async (config) => ({
          rewardId: config.twitch_reward_id,
          twitchReward: null,
          config,
          previewPrice: previewPriceFor(config),
          historyChart: await buildHistoryChart(config),
          ...buildSimulation(config),
        })),
    );
    rewards.push(...unlinkedRows);

    renderView(res, 'channelPointsAdmin', {
      user: req.session.user,
      csrfToken: req.csrfToken(),
      streamer: streamer ?? null,
      isConnected,
      needsReconnect,
      rewards,
      pricingSettings,
      historyHours,
      historyHourOptions: HISTORY_HOUR_OPTIONS,
      error: filterQueryParam(req.query.error, KNOWN_ERRORS),
      success: filterQueryParam(req.query.success, KNOWN_SUCCESSES),
    });
  } catch (err) {
    log.error('Channel Points page error:', err);
    renderError(res, 500, 'Failed to load Channel Points settings.', req.session.user);
  }
});

router.use(channelPointsEventsRouter);
router.use(channelPointsMutationsRouter);

export default router;
