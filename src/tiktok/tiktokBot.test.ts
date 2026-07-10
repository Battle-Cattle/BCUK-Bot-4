import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted state (available inside vi.mock factories) ───────────────────────

const { TikTokLiveConnectionMock, getConnection, setConnectImpl } = vi.hoisted(() => {
  const connectionsByUsername = new Map<string, any>();
  const connectImpls = new Map<string, () => Promise<unknown>>();

  /** Builds a mock TikTokLiveConnection for `username`, consuming any one-shot connect() override set via setConnectImpl. */
  function makeConnection(username: string) {
    const handlers: Record<string, (...args: any[]) => any> = {};
    const impl = connectImpls.get(username);
    connectImpls.delete(username);
    const conn = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => {
        handlers[event] = handler;
      }),
      connect: vi.fn(impl ?? (() => Promise.resolve({ roomId: `room-${username}` }))),
      disconnect: vi.fn(() => Promise.resolve(undefined)),
      /** Invokes the handler registered for `event` via `.on()`, simulating the library emitting it. */
      emit(event: string, ...args: any[]) {
        handlers[event]?.(...args);
      },
    };
    connectionsByUsername.set(username, conn);
    return conn;
  }

  /** Mock constructor standing in for the real `TikTokLiveConnection` class. */
  const TikTokLiveConnectionMock = vi.fn(function (username: string) {
    return makeConnection(username);
  });

  return {
    TikTokLiveConnectionMock,
    /** Returns the mock connection created for `username`, or undefined if none exists yet. */
    getConnection: (username: string) => connectionsByUsername.get(username),
    /** Overrides connect() for the *next* connection created for this username. */
    setConnectImpl: (username: string, impl: () => Promise<unknown>) => {
      connectImpls.set(username, impl);
    },
  };
});

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock('tiktok-live-connector', () => ({
  TikTokLiveConnection: TikTokLiveConnectionMock,
  WebcastEvent: { CHAT: 'chat', STREAM_END: 'streamEnd' },
  ControlEvent: { CONNECTED: 'connected', DISCONNECTED: 'disconnected', ERROR: 'error' },
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../commands/commandRouter', () => ({
  handleCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../shared/statusStore', () => ({
  setTikTokChannel: vi.fn(),
}));

vi.mock('../db', () => ({
  findOwnerUser: vi.fn(),
}));

vi.mock('../discord/discordBot', () => ({
  getDiscordClient: vi.fn(),
}));

vi.mock('../discord/voicePresence', () => ({
  getActiveGuildForUser: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

type TikTokBotModule = typeof import('./tiktokBot');
type CommandRouterModule = typeof import('../commands/commandRouter');
type StatusStoreModule = typeof import('../shared/statusStore');
type DbModule = typeof import('../db');
type DiscordBotModule = typeof import('../discord/discordBot');
type VoicePresenceModule = typeof import('../discord/voicePresence');

const RECONNECT_DELAY_MS = 30_000;

/** Resets the module registry and re-imports tiktokBot with the given config, returning fresh handles to it and its mocks. */
async function setup(
  channels: string[] = [],
  signApiKey: string | undefined = undefined,
): Promise<{
  bot: TikTokBotModule;
  handleCommand: CommandRouterModule['handleCommand'];
  setTikTokChannel: StatusStoreModule['setTikTokChannel'];
  findOwnerUser: DbModule['findOwnerUser'];
  getDiscordClient: DiscordBotModule['getDiscordClient'];
  getActiveGuildForUser: VoicePresenceModule['getActiveGuildForUser'];
}> {
  vi.resetModules();
  vi.doMock('../shared/config', () => ({
    TIKTOK_CHANNELS: channels,
    TIKTOK_SIGN_API_KEY: signApiKey,
  }));
  const commandRouter = await import('../commands/commandRouter.js') as CommandRouterModule;
  const statusStore = await import('../shared/statusStore.js') as StatusStoreModule;
  const db = await import('../db.js') as DbModule;
  const discordBot = await import('../discord/discordBot.js') as DiscordBotModule;
  const voicePresence = await import('../discord/voicePresence.js') as VoicePresenceModule;
  const bot = await import('./tiktokBot.js') as TikTokBotModule;
  vi.mocked(db.findOwnerUser).mockResolvedValue({ discord_id: 'owner-discord-id' } as any);
  vi.mocked(discordBot.getDiscordClient).mockReturnValue({} as any);
  vi.mocked(voicePresence.getActiveGuildForUser).mockReturnValue('guild-A');
  return {
    bot,
    handleCommand: commandRouter.handleCommand,
    setTikTokChannel: statusStore.setTikTokChannel,
    findOwnerUser: db.findOwnerUser,
    getDiscordClient: discordBot.getDiscordClient,
    getActiveGuildForUser: voicePresence.getActiveGuildForUser,
  };
}

let activeBot: TikTokBotModule | undefined;

/** Clears mock state and switches to fake timers before each test. */
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  activeBot = undefined;
});

/** Stops the bot started by the current test and restores real timers. */
afterEach(async () => {
  await activeBot?.stopTikTokBot();
  vi.useRealTimers();
});

// ─── startTikTokBot ───────────────────────────────────────────────────────────

describe('startTikTokBot', () => {
  it('does nothing when no channels are configured', async () => {
    const { bot } = await setup([]);
    activeBot = bot;

    await bot.startTikTokBot();

    expect(TikTokLiveConnectionMock).not.toHaveBeenCalled();
  });

  it('marks every configured channel offline before connecting', async () => {
    const { bot, setTikTokChannel } = await setup(['alice', 'bob']);
    activeBot = bot;

    await bot.startTikTokBot();

    expect(setTikTokChannel).toHaveBeenCalledWith('alice', false);
    expect(setTikTokChannel).toHaveBeenCalledWith('bob', false);
  });

  it('creates a connection for every configured channel without a sign API key', async () => {
    const { bot } = await setup(['alice', 'bob'], undefined);
    activeBot = bot;

    await bot.startTikTokBot();

    expect(TikTokLiveConnectionMock).toHaveBeenCalledWith('alice', { signApiKey: undefined });
    expect(TikTokLiveConnectionMock).toHaveBeenCalledWith('bob', { signApiKey: undefined });
  });

  it('passes the configured sign API key to every connection', async () => {
    const { bot } = await setup(['alice'], 'sign-key-123');
    activeBot = bot;

    await bot.startTikTokBot();

    expect(TikTokLiveConnectionMock).toHaveBeenCalledWith('alice', { signApiKey: 'sign-key-123' });
  });

  it('marks the channel online when CONNECTED fires', async () => {
    const { bot, setTikTokChannel } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    getConnection('alice').emit('connected');

    expect(setTikTokChannel).toHaveBeenCalledWith('alice', true);
  });

  it('disconnects the previous connection when starting again for the same channel', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const first = getConnection('alice');
    await bot.startTikTokBot();
    const second = getConnection('alice');

    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second).not.toBe(first);
  });

  it('schedules a reconnect when connect() rejects', async () => {
    setConnectImpl('alice', () => Promise.reject(new Error('refused')));
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });
});

// ─── chat handler ─────────────────────────────────────────────────────────────

describe('chat handling', () => {
  it('forwards chat messages to handleCommand with the tiktok source, resolved via the bot owner\'s active voice guild', async () => {
    const { bot, handleCommand, findOwnerUser, getActiveGuildForUser } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    getConnection('alice').emit('chat', { content: '!clap' });

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!clap', 'tiktok', 'guild-A');
    expect(findOwnerUser).toHaveBeenCalled();
    expect(getActiveGuildForUser).toHaveBeenCalledWith(expect.anything(), 'owner-discord-id');
  });

  it('passes a null guildId when no bot owner is found', async () => {
    const { bot, handleCommand, findOwnerUser } = await setup(['alice']);
    activeBot = bot;
    vi.mocked(findOwnerUser).mockResolvedValue(null);

    await bot.startTikTokBot();
    getConnection('alice').emit('chat', { content: '!clap' });

    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalledOnce());
    expect(handleCommand).toHaveBeenCalledWith('!clap', 'tiktok', null);
  });

  it('does not throw when the command handler rejects', async () => {
    const { bot, handleCommand } = await setup(['alice']);
    activeBot = bot;
    vi.mocked(handleCommand).mockRejectedValueOnce(new Error('boom'));

    await bot.startTikTokBot();
    getConnection('alice').emit('chat', { content: '!clap' });
    await vi.waitFor(() => expect(handleCommand).toHaveBeenCalled());
  });
});

// ─── reconnect behaviour ──────────────────────────────────────────────────────

describe('reconnect behaviour', () => {
  it('reconnects after STREAM_END', async () => {
    const { bot, setTikTokChannel } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    getConnection('alice').emit('streamEnd');

    expect(setTikTokChannel).toHaveBeenCalledWith('alice', false);
    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('reconnects after DISCONNECTED', async () => {
    const { bot, setTikTokChannel } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    getConnection('alice').emit('disconnected');

    expect(setTikTokChannel).toHaveBeenCalledWith('alice', false);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a second reconnect if STREAM_END and DISCONNECTED both fire', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('streamEnd');
    conn.emit('disconnected');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('disables reconnect after a permanent-failure error and does not reconnect', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('error', new Error('User not found'));
    conn.emit('disconnected');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    // Only the original connection was ever created — no reconnect attempt.
    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an already-scheduled reconnect timer when a permanent-failure error follows it', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('streamEnd'); // schedules a reconnect timer
    conn.emit('error', new Error('account suspended')); // should cancel it

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('still reconnects after a non-permanent error', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('error', new Error('socket hang up'));
    conn.emit('disconnected');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('matches permanent-failure error messages case-insensitively', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('error', new Error('Account BANNED'));
    conn.emit('disconnected');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('treats a non-Error thrown value as the failure message', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;

    await bot.startTikTokBot();
    const conn = getConnection('alice');
    conn.emit('error', 'this channel does not exist');
    conn.emit('disconnected');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects each channel independently', async () => {
    const { bot } = await setup(['alice', 'bob']);
    activeBot = bot;

    await bot.startTikTokBot();
    getConnection('alice').emit('streamEnd');

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(3); // alice, bob, alice-reconnect
    expect(TikTokLiveConnectionMock).toHaveBeenCalledWith('bob', expect.anything());
  });
});

// ─── stopTikTokBot ────────────────────────────────────────────────────────────

describe('stopTikTokBot', () => {
  it('disconnects every active connection', async () => {
    const { bot } = await setup(['alice', 'bob']);
    activeBot = bot;
    await bot.startTikTokBot();
    const alice = getConnection('alice');
    const bob = getConnection('bob');

    await bot.stopTikTokBot();

    expect(alice.disconnect).toHaveBeenCalledOnce();
    expect(bob.disconnect).toHaveBeenCalledOnce();
  });

  it('marks every active channel offline', async () => {
    const { bot, setTikTokChannel } = await setup(['alice']);
    activeBot = bot;
    await bot.startTikTokBot();
    vi.mocked(setTikTokChannel).mockClear();

    await bot.stopTikTokBot();

    expect(setTikTokChannel).toHaveBeenCalledWith('alice', false);
  });

  it('cancels pending reconnect timers so no new connection is created', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;
    await bot.startTikTokBot();
    getConnection('alice').emit('streamEnd'); // schedules a reconnect

    await bot.stopTikTokBot();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the bot was never started', async () => {
    const { bot } = await setup([]);
    activeBot = bot;

    expect(() => bot.stopTikTokBot()).not.toThrow();
  });

  it('allows starting again after being stopped', async () => {
    const { bot } = await setup(['alice']);
    activeBot = bot;
    await bot.startTikTokBot();
    await bot.stopTikTokBot();

    await bot.startTikTokBot();

    expect(TikTokLiveConnectionMock).toHaveBeenCalledTimes(2);
  });
});
