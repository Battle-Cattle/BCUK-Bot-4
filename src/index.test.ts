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
  pingDb: vi.fn().mockResolvedValue(true),
}));
vi.mock('./shared/healthStore', () => ({
  recordDbPing: vi.fn(),
}));
vi.mock('./discord/ownerAlerts', () => ({
  registerOwnerAlertRuntime: vi.fn(),
  primeOwnerAlertBaseline: vi.fn(),
  startOwnerAlertWatcher: vi.fn(),
}));
vi.mock('./discord/discordBot', () => ({
  startDiscordBot: vi.fn(),
  stopDiscordBot: vi.fn(),
  getDiscordClient: vi.fn(),
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
vi.mock('./twitch/twitchChannelReconciliationPoll', () => ({
  startChannelReconciliationPoll: vi.fn(),
  stopChannelReconciliationPoll: vi.fn(),
}));
vi.mock('./twitch/monitor/twitchMonitor', () => ({
  startTwitchMonitor: vi.fn().mockResolvedValue(undefined),
  stopTwitchMonitor: vi.fn().mockResolvedValue(undefined),
  getMultiTwitchDataForChannel: vi.fn(),
}));
vi.mock('./twitch/eventsub/twitchEventSub', () => ({
  startEventSub: vi.fn(),
  stopEventSub: vi.fn(),
  reloadEventSubSubscriptions: vi.fn(),
}));
vi.mock('./twitch/eventsub/twitchEventSubReconciliation', () => ({
  startEventSubReconciliation: vi.fn(),
  stopEventSubReconciliation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./web/server', () => ({ startWebPanel: vi.fn() }));
vi.mock('./audio/audioPlayer', () => ({ disconnect: vi.fn() }));
vi.mock('./commands/customCommandHandler', () => ({ registerTwitchChatRuntime: vi.fn() }));
vi.mock('./commands/counterHandler', () => ({ registerCounterTwitchRuntime: vi.fn() }));
vi.mock('./commands/multiCommandHandler', () => ({ registerMultiTwitchRuntime: vi.fn() }));
vi.mock('./commands/shoutoutHandler', () => ({ registerShoutoutRuntime: vi.fn() }));
vi.mock('./commands/countdownHandler', () => ({ registerCountdownTwitchRuntime: vi.fn() }));
vi.mock('./twitch/eventsub/twitchEventSubRuntime', () => ({
  registerEventSubOverlayRuntime: vi.fn(),
  registerEventSubTwitchRuntime: vi.fn(),
  registerEventSubCompanionRuntime: vi.fn(),
  registerEventSubAlertRuntime: vi.fn(),
  registerEventSubDashboardRuntime: vi.fn(),
  registerEventSubReloadRuntime: vi.fn(),
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
// Captures the 'Bot'-named logger instance each createLogger('Bot') call produces, so tests can
// assert on log.error calls in addition to process.exit — mockLogger() returns a fresh vi.fn()
// set per call, so the instance used inside index.ts isn't otherwise reachable from the test.
let lastBotLogger: ReturnType<typeof mockLogger> | undefined;
vi.mock('./shared/logger', () => ({
  createLogger: (name: string) => {
    const logger = mockLogger();
    if (name === 'Bot') lastBotLogger = logger;
    return logger;
  },
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  // vi.mock() creates one shared mock instance per factory; resetModules clears the
  // module cache but does not reset call counts. clearAllMocks() resets counts to 0
  // so failure-path assertions on mocks like startDiscordBot start from a clean slate.
  vi.clearAllMocks();
  // Each import('./index.js') registers fresh SIGINT/SIGTERM/unhandledRejection/
  // uncaughtException listeners on the real process object; resetModules doesn't
  // remove the old ones. Clear them so a test that emits a signal or error only
  // triggers its own run's handler.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
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
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
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

  it('registers the EventSub reload runtime with reloadEventSubSubscriptions on a clean startup', async () => {
    const { registerEventSubReloadRuntime } = await import('./twitch/eventsub/twitchEventSubRuntime.js');
    const { reloadEventSubSubscriptions } = await import('./twitch/eventsub/twitchEventSub.js');

    await runMain();

    expect(vi.mocked(registerEventSubReloadRuntime)).toHaveBeenCalledWith({ triggerReload: reloadEventSubSubscriptions });
  });

  it('calls process.exit(1) and does not start the bot when reloadGuildRegistry rejects', async () => {
    const { reloadGuildRegistry } = await import('./discord/guildRegistry.js');
    const { startDiscordBot } = await import('./discord/discordBot.js');
    vi.mocked(reloadGuildRegistry).mockRejectedValueOnce(new Error('DB unavailable'));

    await runMain();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(startDiscordBot)).not.toHaveBeenCalled();
  });

  it('records the startup DB ping and registers/primes/starts the owner-alert runtime, in order, on a clean startup', async () => {
    const { recordDbPing } = await import('./shared/healthStore.js');
    const { registerOwnerAlertRuntime, primeOwnerAlertBaseline, startOwnerAlertWatcher } = await import('./discord/ownerAlerts.js');

    await runMain();

    expect(vi.mocked(recordDbPing)).toHaveBeenCalledWith(true);
    expect(vi.mocked(registerOwnerAlertRuntime)).toHaveBeenCalledWith({ send: expect.any(Function) });
    expect(vi.mocked(primeOwnerAlertBaseline)).toHaveBeenCalledOnce();
    expect(vi.mocked(startOwnerAlertWatcher)).toHaveBeenCalledOnce();
    // primeOwnerAlertBaseline must run before the watcher starts listening — otherwise its
    // first health-changed notification compares against an empty baseline (see
    // ownerAlerts.ts's primeOwnerAlertBaseline JSDoc for why that causes false "down" alerts).
    expect(vi.mocked(primeOwnerAlertBaseline).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(startOwnerAlertWatcher).mock.invocationCallOrder[0]);
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
    const { startEventSubReconciliation } = await import('./twitch/eventsub/twitchEventSubReconciliation.js');
    const { startChannelReconciliationPoll } = await import('./twitch/twitchChannelReconciliationPoll.js');

    await runMain();

    expect(vi.mocked(startRewardPricingScheduler)).toHaveBeenCalledOnce();
    expect(vi.mocked(startEventSub)).toHaveBeenCalledOnce();
    expect(vi.mocked(startEventSubReconciliation)).toHaveBeenCalledOnce();
    expect(vi.mocked(startChannelReconciliationPoll)).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('starts the web panel before the channel reconciliation poll, matching the documented startup sequence', async () => {
    const { startWebPanel } = await import('./web/server.js');
    const { startChannelReconciliationPoll } = await import('./twitch/twitchChannelReconciliationPoll.js');

    await runMain();

    expect(vi.mocked(startWebPanel)).toHaveBeenCalledOnce();
    expect(vi.mocked(startChannelReconciliationPoll)).toHaveBeenCalledOnce();

    const [webPanelCallOrder] = vi.mocked(startWebPanel).mock.invocationCallOrder;
    const [reconciliationCallOrder] = vi.mocked(startChannelReconciliationPoll).mock.invocationCallOrder;
    expect(webPanelCallOrder).toBeLessThan(reconciliationCallOrder);
  });
});

describe('DB health check interval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start a second probe while one is still in flight (overlap guard)', async () => {
    // Only fake setInterval/clearInterval — runMain()'s own setImmediate-based settling wait
    // (and anything else main() schedules) keeps running on real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { pingDb } = await import('./db.js');
    let resolvePing!: (ok: boolean) => void;
    vi.mocked(pingDb).mockImplementation(() => new Promise((resolve) => { resolvePing = resolve; }));

    await runMain();
    vi.mocked(pingDb).mockClear();

    // First interval tick starts a probe that never resolves during this window.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(pingDb)).toHaveBeenCalledOnce();

    // A second interval tick fires while the first probe is still pending — the guard
    // should skip it rather than stacking a second call.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(pingDb)).toHaveBeenCalledOnce();

    // Once the in-flight probe resolves, the next tick is free to start a new one.
    resolvePing(true);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(pingDb)).toHaveBeenCalledTimes(2);
  });

  it('logs and recovers (does not get stuck in-flight) when pingDb itself rejects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { pingDb } = await import('./db.js');
    vi.mocked(pingDb).mockRejectedValueOnce(new Error('connection refused'));

    await runMain();
    vi.mocked(pingDb).mockClear();
    lastBotLogger!.error.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(lastBotLogger!.error).toHaveBeenCalledWith('Unexpected error during DB health check:', expect.any(Error));

    // The in-flight guard must have been released in .finally() despite the rejection, or this
    // next tick's probe would be silently skipped.
    vi.mocked(pingDb).mockClear();
    vi.mocked(pingDb).mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(pingDb)).toHaveBeenCalledOnce();
  });
});

describe('owner-alert DM send callback', () => {
  it('throws when the Discord client is not ready', async () => {
    const { registerOwnerAlertRuntime } = await import('./discord/ownerAlerts.js');
    const { getDiscordClient } = await import('./discord/discordBot.js');
    vi.mocked(getDiscordClient).mockReturnValue(undefined as any);

    await runMain();

    const send = vi.mocked(registerOwnerAlertRuntime).mock.calls[0][0].send;
    await expect(send('123', 'hi')).rejects.toThrow('Discord client is not ready');
  });

  it('fetches the user and DMs them when the client is ready', async () => {
    const { registerOwnerAlertRuntime } = await import('./discord/ownerAlerts.js');
    const { getDiscordClient } = await import('./discord/discordBot.js');
    const userSend = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ send: userSend });
    vi.mocked(getDiscordClient).mockReturnValue({ users: { fetch } } as any);

    await runMain();

    const send = vi.mocked(registerOwnerAlertRuntime).mock.calls[0][0].send;
    await send('123', 'hi');

    expect(fetch).toHaveBeenCalledWith('123');
    expect(userSend).toHaveBeenCalledWith('hi');
  });
});

describe('shutdown', () => {
  it('stops the reward pricing scheduler on SIGINT', async () => {
    const { stopRewardPricingScheduler } = await import('./twitch/pricing/rewardPricingScheduler.js');
    const { stopEventSubReconciliation } = await import('./twitch/eventsub/twitchEventSubReconciliation.js');
    const { stopChannelReconciliationPoll } = await import('./twitch/twitchChannelReconciliationPoll.js');

    await runMain();
    process.emit('SIGINT');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(vi.mocked(stopRewardPricingScheduler)).toHaveBeenCalledOnce();
    expect(vi.mocked(stopEventSubReconciliation)).toHaveBeenCalledOnce();
    expect(vi.mocked(stopChannelReconciliationPoll)).toHaveBeenCalledOnce();
  });
});

// ─── Global unhandled error handlers ──────────────────────────────────────────

describe('global error handlers', () => {
  it('logs and exits the process on an unhandled promise rejection', async () => {
    await runMain();
    const reason = new Error('boom');

    expect(() => {
      process.emit('unhandledRejection', reason, Promise.reject(reason).catch(() => {}));
    }).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(lastBotLogger?.error).toHaveBeenCalledWith('Unhandled promise rejection:', reason);
  });

  it('logs and exits the process on an uncaught exception', async () => {
    await runMain();
    const err = new Error('boom');

    expect(() => {
      process.emit('uncaughtException', err);
    }).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(lastBotLogger?.error).toHaveBeenCalledWith('Uncaught exception:', err);
  });
});
