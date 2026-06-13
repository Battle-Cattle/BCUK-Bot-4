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
}));
vi.mock('./web/routes/overlaySource', () => ({ pushOverlayEvent: vi.fn() }));
vi.mock('./commands/counterScheduler', () => ({
  startCounterScheduler: vi.fn(),
  stopCounterScheduler: vi.fn(),
}));
vi.mock('./shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
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

  it('calls process.exit(1) when reloadGuildRegistry rejects', async () => {
    const { reloadGuildRegistry } = await import('./discord/guildRegistry.js');
    vi.mocked(reloadGuildRegistry).mockRejectedValueOnce(new Error('DB unavailable'));

    await runMain();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when the DB connection ping fails', async () => {
    const db = await import('./db.js');
    vi.mocked(db.getPool).mockReturnValueOnce({
      getConnection: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    } as any);

    await runMain();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
