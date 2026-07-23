import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from './test-utils/loggerMock';

// All vi.mock calls are hoisted before imports. After vi.resetModules() in beforeEach,
// re-importing any of these modules will re-run the factory and give fresh vi.fn() instances.

vi.mock('mediaplex', () => ({}));
vi.mock('./db', () => ({
  getPool: vi.fn(() => ({
    getConnection: vi.fn().mockResolvedValue({
      ping: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    }),
  })),
  closePool: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./discord/discordBot', () => ({
  startDiscordBot: vi.fn(),
  stopDiscordBot: vi.fn(),
}));
vi.mock('./discord/guildRegistry', () => ({
  reloadGuildRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitch/twitchBot', () => ({
  startTwitchBot: vi.fn().mockResolvedValue(undefined),
  stopTwitchBot: vi.fn().mockResolvedValue(undefined),
  sayInChannel: vi.fn(),
}));
vi.mock('./twitch/twitchChannelMembership', () => ({
  getActiveChannels: vi.fn(),
  getActiveChannelUserIds: vi.fn(),
  setChannelJoinedHook: vi.fn(),
}));
vi.mock('./twitch/monitor/twitchMonitor', () => ({
  startTwitchMonitor: vi.fn().mockResolvedValue(undefined),
  stopTwitchMonitor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitch/eventsub/twitchEventSub', () => ({
  startEventSub: vi.fn(),
  stopEventSub: vi.fn(),
  reloadEventSubSubscriptions: vi.fn(),
}));
vi.mock('./web/server', () => ({ startWebPanel: vi.fn() }));
vi.mock('./audio/audioPlayer', () => ({ disconnect: vi.fn() }));
vi.mock('./commands/customCommandHandler', () => ({ registerTwitchChatRuntime: vi.fn() }));
vi.mock('./commands/counterHandler', () => ({ registerCounterTwitchRuntime: vi.fn() }));
vi.mock('./commands/multiCommandHandler', () => ({ registerMultiTwitchRuntime: vi.fn() }));
vi.mock('./commands/shoutoutHandler', () => ({ registerShoutoutRuntime: vi.fn() }));
vi.mock('./commands/countdownHandler', () => ({ registerCountdownTwitchRuntime: vi.fn() }));
vi.mock('./trivia/triviaTwitchHandler', () => ({ registerTriviaTwitchRuntime: vi.fn() }));
vi.mock('./trivia/triviaGame', () => ({ registerTriviaPush: vi.fn() }));
vi.mock('./web/routes/triviaOverlaySource', () => ({ pushTriviaEvent: vi.fn() }));
vi.mock('./twitch/eventsub/twitchEventSubRuntime', () => ({
  registerEventSubOverlayRuntime: vi.fn(),
  registerEventSubTwitchRuntime: vi.fn(),
  registerEventSubCompanionRuntime: vi.fn(),
  registerEventSubAlertRuntime: vi.fn(),
  registerEventSubDashboardRuntime: vi.fn(),
}));
vi.mock('./web/routes/overlaySource', () => ({ pushOverlayEvent: vi.fn() }));
vi.mock('./web/routes/companionEvents', () => ({ pushCompanionEvent: vi.fn() }));
vi.mock('./web/routes/alertsOverlaySource', () => ({ pushAlertEvent: vi.fn() }));
vi.mock('./web/routes/channelPointsEvents', () => ({ pushPricingUpdate: vi.fn() }));
vi.mock('./web/routes/dashboardEvents', () => ({ pushDashboardEvent: vi.fn() }));
vi.mock('./commands/counterScheduler', () => ({
  startCounterScheduler: vi.fn(),
  stopCounterScheduler: vi.fn(),
}));
vi.mock('./twitch/pricing/rewardPricingScheduler', () => ({
  startRewardPricingScheduler: vi.fn(),
  stopRewardPricingScheduler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./twitch/pricing/rewardPricingService', () => ({
  registerRewardPricingRuntime: vi.fn(),
}));
vi.mock('./shared/logger', () => ({ createLogger: mockLogger }));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  // vi.mock() creates one shared mock instance per factory; resetModules clears the
  // module cache but does not reset call counts. clearAllMocks() resets counts to 0
  // so failure-path assertions on mocks like startDiscordBot start from a clean slate.
  vi.clearAllMocks();
  // Each import('./index.js') registers fresh SIGINT/SIGTERM listeners on the real
  // process object; resetModules doesn't remove the old ones. Clear them so a test
  // that emits a signal only triggers its own run's shutdown() closure.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  // Throw on the first call so main() stops executing after a catch block calls
  // process.exit(1). Revert to a no-op on subsequent calls so the outer
  // main().catch() path — which also calls process.exit(1) after the inner throw
  // propagates out — doesn't produce an unhandled rejection.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    exitSpy.mockImplementation((() => {}) as never);
    throw new Error('process.exit');
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

/** Imports index.ts (which fires main() immediately) and waits for it to settle. */
async function runMain(): Promise<void> {
  await import('./index.js');
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Startup preload contract ─────────────────────────────────────────────────

describe('startup — guild registry preload', () => {
  it('calls reloadGuildRegistry before startDiscordBot on a clean startup', async () => {
    const { reloadGuildRegistry } = await import('./discord/guildRegistry.js');
    const { startDiscordBot } = await import('./discord/discordBot.js');

    await runMain();

    expect(vi.mocked(reloadGuildRegistry)).toHaveBeenCalledOnce();
    expect(vi.mocked(startDiscordBot)).toHaveBeenCalledOnce();

    const [registryCallOrder] = vi.mocked(reloadGuildRegistry).mock.invocationCallOrder;
    const [botCallOrder] = vi.mocked(startDiscordBot).mock.invocationCallOrder;
    expect(registryCallOrder).toBeLessThan(botCallOrder);
  });

  it('registers the companion event runtime with pushCompanionEvent on a clean startup', async () => {
    const { registerEventSubCompanionRuntime } = await import('./twitch/eventsub/twitchEventSubRuntime.js');
    const { pushCompanionEvent } = await import('./web/routes/companionEvents.js');

    await runMain();

    expect(vi.mocked(registerEventSubCompanionRuntime)).toHaveBeenCalledWith({ pushCompanionEvent });
  });

  it('registers the alerts overlay runtime with pushAlertEvent on a clean startup', async () => {
    const { registerEventSubAlertRuntime } = await import('./twitch/eventsub/twitchEventSubRuntime.js');
    const { pushAlertEvent } = await import('./web/routes/alertsOverlaySource.js');

    await runMain();

    expect(vi.mocked(registerEventSubAlertRuntime)).toHaveBeenCalledWith({ pushAlertEvent });
  });

  it('registers the reward pricing runtime with pushPricingUpdate on a clean startup', async () => {
    const { registerRewardPricingRuntime } = await import('./twitch/pricing/rewardPricingService.js');
    const { pushPricingUpdate } = await import('./web/routes/channelPointsEvents.js');

    await runMain();

    expect(vi.mocked(registerRewardPricingRuntime)).toHaveBeenCalledWith({ pushPricingUpdate });
  });

  it('registers the dashboard events runtime with pushDashboardEvent on a clean startup', async () => {
    const { registerEventSubDashboardRuntime } = await import('./twitch/eventsub/twitchEventSubRuntime.js');
    const { pushDashboardEvent } = await import('./web/routes/dashboardEvents.js');

    await runMain();

    expect(vi.mocked(registerEventSubDashboardRuntime)).toHaveBeenCalledWith({ pushDashboardEvent });
  });

  it('registers the trivia Twitch runtime and push function on a clean startup', async () => {
    const { registerTriviaTwitchRuntime } = await import('./trivia/triviaTwitchHandler.js');
    const { registerTriviaPush } = await import('./trivia/triviaGame.js');
    const { pushTriviaEvent } = await import('./web/routes/triviaOverlaySource.js');
    const { sayInChannel } = await import('./twitch/twitchBot.js');

    await runMain();

    expect(vi.mocked(registerTriviaTwitchRuntime)).toHaveBeenCalledWith({ send: sayInChannel });
    expect(vi.mocked(registerTriviaPush)).toHaveBeenCalledWith(pushTriviaEvent);
  });

  it('calls process.exit(1) and does not start the bot when reloadGuildRegistry rejects', async () => {
    const { reloadGuildRegistry } = await import('./discord/guildRegistry.js');
    const { startDiscordBot } = await import('./discord/discordBot.js');
    vi.mocked(reloadGuildRegistry).mockRejectedValueOnce(new Error('DB unavailable'));

    await runMain();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(startDiscordBot)).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) and does not start the bot when the DB connection ping fails', async () => {
    const db = await import('./db.js');
    const { startDiscordBot } = await import('./discord/discordBot.js');
    vi.mocked(db.getPool).mockReturnValueOnce({
      getConnection: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    } as any);

    await runMain();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(startDiscordBot)).not.toHaveBeenCalled();
  });
});

// ─── Reward pricing scheduler startup/shutdown ────────────────────────────────

describe('startup — reward pricing scheduler', () => {
  it('starts the scheduler and continues startup through to startEventSub on a clean run', async () => {
    const { startRewardPricingScheduler } = await import('./twitch/pricing/rewardPricingScheduler.js');
    const { startEventSub } = await import('./twitch/eventsub/twitchEventSub.js');

    await runMain();

    expect(vi.mocked(startRewardPricingScheduler)).toHaveBeenCalledOnce();
    expect(vi.mocked(startEventSub)).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('shutdown', () => {
  it('stops the reward pricing scheduler on SIGINT', async () => {
    const { stopRewardPricingScheduler } = await import('./twitch/pricing/rewardPricingScheduler.js');

    await runMain();
    process.emit('SIGINT');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(vi.mocked(stopRewardPricingScheduler)).toHaveBeenCalledOnce();
  });
});
