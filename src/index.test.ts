import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  initGlobalPricingSettings: vi.fn().mockResolvedValue(undefined),
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
vi.mock('./tiktok/tiktokBot', () => ({
  startTikTokBot: vi.fn().mockResolvedValue(undefined),
  stopTikTokBot: vi.fn(),
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
vi.mock('./twitch/eventsub/twitchEventSubHandler', () => ({
  registerEventSubOverlayRuntime: vi.fn(),
  registerEventSubTwitchRuntime: vi.fn(),
  registerEventSubCompanionRuntime: vi.fn(),
}));
vi.mock('./web/routes/overlaySource', () => ({ pushOverlayEvent: vi.fn() }));
vi.mock('./web/routes/companionEvents', () => ({ pushCompanionEvent: vi.fn() }));
vi.mock('./commands/counterScheduler', () => ({
  startCounterScheduler: vi.fn(),
  stopCounterScheduler: vi.fn(),
}));
vi.mock('./twitch/pricing/rewardPricingScheduler', () => ({
  startRewardPricingScheduler: vi.fn(),
  stopRewardPricingScheduler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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
    const { registerEventSubCompanionRuntime } = await import('./twitch/eventsub/twitchEventSubHandler.js');
    const { pushCompanionEvent } = await import('./web/routes/companionEvents.js');

    await runMain();

    expect(vi.mocked(registerEventSubCompanionRuntime)).toHaveBeenCalledWith({ pushCompanionEvent });
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
  it('starts the scheduler after initializing global pricing settings', async () => {
    const db = await import('./db.js');
    const { startRewardPricingScheduler } = await import('./twitch/pricing/rewardPricingScheduler.js');

    await runMain();

    expect(vi.mocked(db.initGlobalPricingSettings)).toHaveBeenCalledOnce();
    expect(vi.mocked(startRewardPricingScheduler)).toHaveBeenCalledOnce();

    const [initCallOrder] = vi.mocked(db.initGlobalPricingSettings).mock.invocationCallOrder;
    const [schedulerCallOrder] = vi.mocked(startRewardPricingScheduler).mock.invocationCallOrder;
    expect(initCallOrder).toBeLessThan(schedulerCallOrder);
  });

  it('logs an error and continues starting up when initGlobalPricingSettings rejects', async () => {
    const db = await import('./db.js');
    const { startRewardPricingScheduler } = await import('./twitch/pricing/rewardPricingScheduler.js');
    const { startEventSub } = await import('./twitch/eventsub/twitchEventSub.js');
    vi.mocked(db.initGlobalPricingSettings).mockRejectedValueOnce(new Error('db down'));

    await runMain();

    expect(vi.mocked(startRewardPricingScheduler)).not.toHaveBeenCalled();
    // Startup continues past the failed try/catch to the rest of main() instead of aborting.
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
