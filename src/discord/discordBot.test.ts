import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';
import { flushMicrotasks } from '../test-utils/flushMicrotasks';
import { deferred } from '../test-utils/deferredPromise';

vi.mock('../shared/config', () => ({
  DISCORD_TOKEN: 'mock-token',
  SFX_FOLDER: '/tmp/sfx',
  OVERLAY_FOLDER: '/tmp/overlay',
  GLOBAL_COOLDOWN_MS: 0,
  EVENTSUB_TOKEN_SECRET: undefined,
}));
vi.mock('../commands/commandRouter', () => ({
  handleCommand: vi.fn().mockResolvedValue(undefined),
  forgetGuildCommandState: vi.fn(),
}));
vi.mock('../commands/customCommandHandler', () => ({
  executeCustomCommandForDiscord: vi.fn().mockResolvedValue(undefined),
  forgetGuildCustomCommandCooldown: vi.fn(),
}));
vi.mock('../commands/counterHandler', () => ({
  executeCounterCommandForDiscord: vi.fn().mockResolvedValue(undefined),
  forgetGuildCounterCooldown: vi.fn(),
}));
vi.mock('../shared/statusStore', () => ({ setDiscordReady: vi.fn(), clearVoiceStatus: vi.fn() }));
vi.mock('../shared/healthStore', () => ({ recordDiscordConnected: vi.fn() }));
vi.mock('../commands/healthCommandHandler', () => ({ executeHealthCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../audio/audioPlayer', () => ({ forgetGuild: vi.fn(), disconnect: vi.fn() }));
vi.mock('./guildRefreshState', () => ({ forgetGuildRefreshState: vi.fn() }));
vi.mock('./ownerAlerts', () => ({ sendOwnerAlert: vi.fn().mockResolvedValue(true) }));
vi.mock('./guildRegistry', () => ({
  // Only the legacy configured guild is registered in these tests.
  isRegisteredGuild: vi.fn((id: string) => id === 'guild-id'),
  reloadGuildRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db', () => ({
  upsertGuild: vi.fn().mockResolvedValue(undefined),
  getGuildById: vi.fn().mockResolvedValue(null),
  findUser: vi.fn().mockResolvedValue(null),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  setMemberAccessLevel: vi.fn().mockResolvedValue(undefined),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../shared/logger', () => ({ createLogger: vi.fn(mockLogger) }));
vi.mock('discord.js', () => ({
  Client: vi.fn(),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 8, DirectMessages: 16 },
  Partials: { Channel: 1 },
}));

type DiscordBotModule = typeof import('./discordBot');
type CommandRouterModule = typeof import('../commands/commandRouter');
type CustomCommandModule = typeof import('../commands/customCommandHandler');

let mod: DiscordBotModule;
let commands: CommandRouterModule;
let customCmds: CustomCommandModule;
let mockInstance: ReturnType<typeof makeMockClient>;
let mockGuild: { name: string; members: { fetch: ReturnType<typeof vi.fn> } };
let mockLog: ReturnType<typeof mockLogger>;

function makeMockClient() {
  mockGuild = { name: 'TestGuild', members: { fetch: vi.fn().mockResolvedValue({ displayName: 'Alice' }) } };
  return {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    user: { tag: 'Bot#1234' },
    guilds: {
      cache: { get: vi.fn().mockReturnValue(null) },
      fetch: vi.fn().mockResolvedValue(mockGuild),
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  // vi.mock() creates one shared mock instance per factory; resetModules clears the
  // module cache but not call counts, so clearAllMocks() is needed before each test.
  vi.clearAllMocks();
  mockInstance = makeMockClient();
  const djs = await import('discord.js');
  vi.mocked(djs.Client).mockImplementation(function () { return mockInstance; } as any);
  // Import commandRouter first so discordBot.ts picks up the same cached instance
  commands = await import('../commands/commandRouter.js') as CommandRouterModule;
  customCmds = await import('../commands/customCommandHandler.js') as CustomCommandModule;
  const loggerModule = await import('../shared/logger.js');
  mod = await import('./discordBot.js') as DiscordBotModule;
  mockLog = vi.mocked(loggerModule.createLogger).mock.results[0]?.value;
});

// ─── getDiscordClient ─────────────────────────────────────────────────────────

describe('getDiscordClient', () => {
  it('returns null before startDiscordBot is called', () => {
    expect(mod.getDiscordClient()).toBeNull();
  });

  it('returns null after startDiscordBot but before clientReady fires', () => {
    mod.startDiscordBot();
    expect(mod.getDiscordClient()).toBeNull();
  });

  it('is idempotent — a second call while booting does not create a second Client', () => {
    mod.startDiscordBot();
    mod.startDiscordBot(); // should be a no-op
    expect(mockInstance.login).toHaveBeenCalledOnce();
  });

  it('returns the client instance after clientReady fires', async () => {
    mod.startDiscordBot();
    expect(mod.getDiscordClient()).toBeNull();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(mod.getDiscordClient()).toBe(mockInstance);
  });
});

// ─── onceDiscordReady ───────────────────────────────────────────────────────────

describe('onceDiscordReady', () => {
  it('resolves immediately when the client is already ready', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    await expect(mod.onceDiscordReady()).resolves.toBeUndefined();
  });

  it('resolves once clientReady fires, not before', async () => {
    mod.startDiscordBot();
    let resolved = false;
    const waiter = mod.onceDiscordReady().then(() => { resolved = true; });

    await flushMicrotasks();
    expect(resolved).toBe(false);

    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    await waiter;
    expect(resolved).toBe(true);
  });

  it('resolves every waiter registered before clientReady fires', async () => {
    mod.startDiscordBot();
    const waiterA = mod.onceDiscordReady();
    const waiterB = mod.onceDiscordReady();

    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    await expect(Promise.all([waiterA, waiterB])).resolves.toEqual([undefined, undefined]);
  });
});

// ─── fetchMemberDisplayName ───────────────────────────────────────────────────

describe('fetchMemberDisplayName', () => {
  it('returns null when client is not ready', async () => {
    expect(await mod.fetchMemberDisplayName('123', 'guild-id', false)).toBeNull();
  });

  it('returns the member displayName when client is ready and fetch succeeds', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);  // fires clientReady → sets client

    const result = await mod.fetchMemberDisplayName('user123', 'guild-id', false);
    expect(result).toBe('Alice');
  });

  it('returns null when guild member fetch throws', async () => {
    mockGuild.members.fetch.mockRejectedValueOnce(new Error('not found'));
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    const result = await mod.fetchMemberDisplayName('missing', 'guild-id', false);
    expect(result).toBeNull();
  });
});

// ─── startDiscordBot — messageCreate handler ──────────────────────────────────

describe('startDiscordBot — messageCreate handler', () => {
  function getMessageCreateCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'messageCreate')?.[1] as (...args: any[]) => unknown;
  }

  it('skips bot messages without calling command handlers', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: true }, guildId: 'guild-id', content: '!test', member: null });
    expect(vi.mocked(commands.handleCommand)).not.toHaveBeenCalled();
  });

  it('skips messages from an unregistered guild', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: false, username: 'Alice' }, guildId: 'other-guild', content: '!test', member: null });
    expect(vi.mocked(commands.handleCommand)).not.toHaveBeenCalled();
  });

  it('skips guild-gated handlers for DMs (no guildId)', async () => {
    const counters = await import('../commands/counterHandler.js');
    const cb = getMessageCreateCb();
    cb({ author: { bot: false, username: 'Alice' }, guildId: null, content: '!test', member: null });
    expect(vi.mocked(commands.handleCommand)).not.toHaveBeenCalled();
    expect(vi.mocked(customCmds.executeCustomCommandForDiscord)).not.toHaveBeenCalled();
    expect(vi.mocked(counters.executeCounterCommandForDiscord)).not.toHaveBeenCalled();
  });

  it('still dispatches DMs to the health command handler', async () => {
    const health = await import('../commands/healthCommandHandler.js');
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: null, content: '!health', member: null };
    cb(msg);
    expect(vi.mocked(health.executeHealthCommandForDiscord)).toHaveBeenCalledWith(msg);
  });

  it('dispatches to command handlers for registered guild messages', () => {
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: 'guild-id', content: '!test', member: { displayName: 'Alice' } };
    cb(msg);
    expect(vi.mocked(commands.handleCommand)).toHaveBeenCalledWith('!test', 'discord', 'guild-id', '!test');
    expect(vi.mocked(customCmds.executeCustomCommandForDiscord)).toHaveBeenCalledWith(msg, 'Alice', 'guild-id', '!test');
  });

  it('dispatches to the health command handler for registered guild messages', async () => {
    const health = await import('../commands/healthCommandHandler.js');
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: 'guild-id', content: '!health', member: { displayName: 'Alice' } };
    cb(msg);
    expect(vi.mocked(health.executeHealthCommandForDiscord)).toHaveBeenCalledWith(msg, '!health');
  });
});

// ─── startDiscordBot — guildCreate handler ────────────────────────────────────

describe('startDiscordBot — guildCreate handler', () => {
  function getGuildCreateCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'guildCreate')?.[1] as (...args: any[]) => unknown;
  }

  /** Builds a minimal discord.js Guild-like object for a brand-new guild, with a mocked `fetchOwner`. */
  function makeNewGuild(ownerId = 'owner-id') {
    return {
      id: 'new-guild',
      name: 'New Server',
      fetchOwner: vi.fn().mockResolvedValue({ id: ownerId, user: { username: 'OwnerName', tag: 'OwnerName#0001' } }),
    };
  }

  it('registers a brand-new guild, grants its Discord owner Admin access, and reloads the registry', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    const guild = makeNewGuild();
    const cb = getGuildCreateCb();

    await cb(guild);
    // Let the async guildCreate handler settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.upsertGuild)).toHaveBeenCalledWith('new-guild', 'New Server');
    expect(vi.mocked(guilds.findUser)).toHaveBeenCalledWith('owner-id');
    expect(vi.mocked(guilds.upsertUser)).toHaveBeenCalledWith('owner-id', 'OwnerName', guilds.AccessLevel.USER);
    expect(vi.mocked(guilds.setMemberAccessLevel)).toHaveBeenCalledWith('new-guild', 'owner-id', guilds.AccessLevel.ADMIN);
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();

    const [upsertOrder] = vi.mocked(guilds.upsertGuild).mock.invocationCallOrder;
    const [grantOrder] = vi.mocked(guilds.setMemberAccessLevel).mock.invocationCallOrder;
    const [reloadOrder] = vi.mocked(registry.reloadGuildRegistry).mock.invocationCallOrder;
    expect(upsertOrder).toBeLessThan(grantOrder);
    expect(grantOrder).toBeLessThan(reloadOrder);
  });

  it('does not overwrite an already-whitelisted owner, but still grants them guild access', async () => {
    const guilds = await import('../db.js');
    vi.mocked(guilds.findUser).mockResolvedValueOnce({ discord_id: 'owner-id', discord_name: 'Existing', access_level: 2 } as any);
    const guild = makeNewGuild();
    const cb = getGuildCreateCb();

    await cb(guild);
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.upsertUser)).not.toHaveBeenCalled();
    expect(vi.mocked(guilds.setMemberAccessLevel)).toHaveBeenCalledWith('new-guild', 'owner-id', guilds.AccessLevel.ADMIN);
  });

  it('does not grant owner access when the guild already exists (reconnect, not a new guild)', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    vi.mocked(guilds.getGuildById).mockResolvedValueOnce({ guild_id: 'existing-guild', name: 'Existing', voice_channel_id: null });
    const guild = { id: 'existing-guild', name: 'Existing', fetchOwner: vi.fn() };
    const cb = getGuildCreateCb();

    await cb(guild);
    await new Promise((resolve) => setImmediate(resolve));

    expect(guild.fetchOwner).not.toHaveBeenCalled();
    expect(vi.mocked(guilds.setMemberAccessLevel)).not.toHaveBeenCalled();
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();
  });

  it('swallows fetchOwner errors during owner provisioning and still reloads the registry', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    const guild = makeNewGuild();
    vi.mocked(guild.fetchOwner).mockRejectedValueOnce(new Error('owner fetch failed'));
    const cb = getGuildCreateCb();

    await cb(guild);
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.setMemberAccessLevel)).not.toHaveBeenCalled();
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();
  });

  it('propagates a DB failure during the owner grant and does not call reloadGuildRegistry', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    vi.mocked(guilds.setMemberAccessLevel).mockRejectedValueOnce(new Error('db error'));
    const cb = getGuildCreateCb();

    cb(makeNewGuild());
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(registry.reloadGuildRegistry)).not.toHaveBeenCalled();
  });

  it('swallows upsertGuild errors and does not call reloadGuildRegistry', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    vi.mocked(guilds.upsertGuild).mockRejectedValueOnce(new Error('db error'));
    const cb = getGuildCreateCb();

    cb(makeNewGuild());
    // Let the promise chain's .catch branch execute.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.setMemberAccessLevel)).not.toHaveBeenCalled();
    expect(vi.mocked(registry.reloadGuildRegistry)).not.toHaveBeenCalled();
  });

  it('serializes provisioning across concurrent guildCreate events for the same owner via userMutationQueue', async () => {
    const guilds = await import('../db.js');
    const order: string[] = [];
    const { promise: gate, resolve: openGate } = deferred();

    vi.mocked(guilds.findUser)
      .mockImplementationOnce(async () => {
        order.push('a-findUser-start');
        await gate;
        order.push('a-findUser-end');
        return null;
      })
      .mockImplementationOnce(async () => {
        // Guild A's owner row now exists, so guild B's provisioning skips upsertUser and only
        // grants guild access — matching provisionGuildOwner's "don't overwrite an existing
        // user" behavior.
        order.push('b-findUser');
        return { discord_id: 'same-owner', discord_name: 'OwnerName', access_level: 0 } as any;
      });
    vi.mocked(guilds.upsertUser).mockImplementation(async () => { order.push('a-upsertUser'); });
    vi.mocked(guilds.setMemberAccessLevel).mockImplementation(async (guildId: string) => {
      order.push(`${guildId === 'guild-a' ? 'a' : 'b'}-setMemberAccessLevel`);
    });

    const guildA = { ...makeNewGuild('same-owner'), id: 'guild-a' };
    const guildB = { ...makeNewGuild('same-owner'), id: 'guild-b' };
    const cb = getGuildCreateCb();

    cb(guildA);
    await flushMicrotasks();
    cb(guildB);
    await flushMicrotasks();

    // guild B's provisioning must not start — not even its findUser lookup — until guild A's
    // entire queued sequence (upsertUser, then setMemberAccessLevel) has finished, since they
    // share an owner and are serialised through userMutationQueue. If either write were moved
    // outside the queue, it would show up here before 'a-findUser-end'.
    expect(order).toEqual(['a-findUser-start']);

    openGate();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual([
      'a-findUser-start', 'a-findUser-end', 'a-upsertUser', 'a-setMemberAccessLevel',
      'b-findUser', 'b-setMemberAccessLevel',
    ]);
  });
});

// ─── startDiscordBot — guildDelete handler ────────────────────────────────────

describe('startDiscordBot — guildDelete handler', () => {
  function getGuildDeleteCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'guildDelete')?.[1] as (...args: any[]) => unknown;
  }

  it('forgets the departed guild\'s in-memory voice, command, cooldown, status, and refresh state', async () => {
    const audioPlayer = await import('../audio/audioPlayer.js');
    const status = await import('../shared/statusStore.js');
    const guildRefreshState = await import('./guildRefreshState.js');
    const counterHandler = await import('../commands/counterHandler.js');
    const cb = getGuildDeleteCb();

    cb({ id: 'departed-guild', name: 'Departed Server' });

    expect(vi.mocked(audioPlayer.forgetGuild)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(commands.forgetGuildCommandState)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(customCmds.forgetGuildCustomCommandCooldown)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(counterHandler.forgetGuildCounterCooldown)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(status.clearVoiceStatus)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(guildRefreshState.forgetGuildRefreshState)).toHaveBeenCalledWith('departed-guild');
  });

  it('does not touch the guild DB row', async () => {
    const guilds = await import('../db.js');
    const cb = getGuildDeleteCb();

    cb({ id: 'departed-guild', name: 'Departed Server' });

    expect(vi.mocked(guilds.upsertGuild)).not.toHaveBeenCalled();
  });
});

// ─── startDiscordBot — clientReady ready state ─────────────────────────────────

describe('startDiscordBot — clientReady ready state', () => {
  it('sets ready state with the bot tag on clientReady success', async () => {
    const status = await import('../shared/statusStore.js');
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(vi.mocked(status.setDiscordReady)).toHaveBeenCalledWith('Bot#1234');
  });

  it('records the Discord connection as up on clientReady success', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(true);
  });
});

// ─── startDiscordBot — error event ───────────────────────────────────────────

describe('startDiscordBot — error event', () => {
  it('registers an error handler that does not throw', () => {
    mod.startDiscordBot();
    const errorCb = mockInstance.on.mock.calls.find(([event]: string[]) => event === 'error')?.[1] as (...args: any[]) => unknown;
    expect(() => errorCb(new Error('ws error'))).not.toThrow();
  });
});

// ─── startDiscordBot — gateway watchdog ────────────────────────────────────────

describe('startDiscordBot — gateway watchdog', () => {
  /** Finds the handler registered for `event` via `mockInstance.on`. */
  function findHandler(event: string): (...args: any[]) => unknown {
    return mockInstance.on.mock.calls.find(([e]: string[]) => e === event)?.[1];
  }

  it('logs a warning with the shard id when a shard is reconnecting, without throwing', () => {
    mod.startDiscordBot();
    const handler = findHandler('shardReconnecting');
    expect(() => handler(0)).not.toThrow();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('0'));
  });

  it('logs an error with the shard id and error the first time a shard reports a gateway connection error, and DMs the owner, without throwing', async () => {
    const ownerAlerts = await import('./ownerAlerts.js');
    mod.startDiscordBot();
    const handler = findHandler('shardError');
    const gatewayError = new Error('gateway socket error');
    expect(() => handler(gatewayError, 0)).not.toThrow();
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('0'), gatewayError);
    expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('Shard 0'));
  });

  it('throttles repeated shardError logs/owner DMs for the same shard to one per interval, folding in a suppressed count', async () => {
    const ownerAlerts = await import('./ownerAlerts.js');
    vi.useFakeTimers();
    try {
      mod.startDiscordBot();
      const handler = findHandler('shardError');
      const gatewayError = new Error('gateway socket error');

      handler(gatewayError, 0);
      handler(gatewayError, 0);
      handler(gatewayError, 0);
      expect(mockLog.error).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      handler(gatewayError, 0);
      expect(mockLog.error).toHaveBeenCalledTimes(2);
      expect(mockLog.error).toHaveBeenLastCalledWith(expect.stringContaining('2 more suppressed'), gatewayError);
      expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenLastCalledWith(expect.stringContaining('2 more suppressed'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs shardError independently per shard, without one shard throttling another', () => {
    mod.startDiscordBot();
    const handler = findHandler('shardError');
    const gatewayError = new Error('gateway socket error');

    handler(gatewayError, 0);
    handler(gatewayError, 1);
    expect(mockLog.error).toHaveBeenCalledTimes(2);
  });

  it('records the Discord connection as down on every shardError, even throttled ones, so the health dashboard reflects an ongoing gateway outage', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const handler = findHandler('shardError');
    const gatewayError = new Error('Unexpected server response: 503');

    handler(gatewayError, 0);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenLastCalledWith(false);

    // A second error within the log-throttle window is swallowed for logging purposes,
    // but the connection is still down and must still be reflected.
    vi.mocked(healthStore.recordDiscordConnected).mockClear();
    handler(gatewayError, 0);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(false);
  });

  it('records the Discord connection as up when a shard becomes ready again', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const handler = findHandler('shardReady');
    handler(0);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(true);
  });

  it('records the Discord connection as up when a shard resumes', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const handler = findHandler('shardResume');
    handler(0, 5);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(true);
  });

  it('forces a fresh login when a shard disconnects permanently', () => {
    mod.startDiscordBot();
    expect(mockInstance.login).toHaveBeenCalledOnce();

    const handler = findHandler('shardDisconnect');
    handler({ code: 4004 }, 0);

    // stopDiscordBot() destroyed the dead client, and startDiscordBot() logged back in.
    expect(mockInstance.destroy).toHaveBeenCalledOnce();
    expect(mockInstance.login).toHaveBeenCalledTimes(2);
    expect(mod.getDiscordClient()).toBeNull();
  });

  it('records the Discord connection as down when a shard disconnects permanently', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const handler = findHandler('shardDisconnect');
    handler({ code: 4004 }, 0);
    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(false);
  });

  it('disconnects every guild\'s voice connection before replacing the client, so none are orphaned against the destroyed one', async () => {
    const audioPlayer = await import('../audio/audioPlayer.js');
    mod.startDiscordBot();
    const handler = findHandler('shardDisconnect');
    handler({ code: 4004 }, 0);

    // No guildId — every guild loses its client here, not just one.
    expect(vi.mocked(audioPlayer.disconnect)).toHaveBeenCalledWith();
    const [disconnectOrder] = vi.mocked(audioPlayer.disconnect).mock.invocationCallOrder;
    const [destroyOrder] = mockInstance.destroy.mock.invocationCallOrder;
    expect(disconnectOrder).toBeLessThan(destroyOrder);
  });
});

// ─── startDiscordBot — gateway stall watchdog ──────────────────────────────────
//
// Covers the fallback for when discord.js's own reconnect loop gets stuck without ever firing
// 'shardDisconnect' (no close code — the socket handshake itself keeps failing, e.g. a sustained
// run of `Unexpected server response: 503`), and so never reaches the existing self-heal.

describe('startDiscordBot — gateway stall watchdog', () => {
  /** Finds the handler registered for `event` via `mockInstance.on`. */
  function findHandler(event: string): (...args: any[]) => unknown {
    return mockInstance.on.mock.calls.find(([e]: string[]) => e === event)?.[1];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forces a fresh login when no shard activity occurs for the stall threshold', async () => {
    mod.startDiscordBot();
    expect(mockInstance.login).toHaveBeenCalledOnce();

    // No shardReconnecting/shardError/shardReady/shardDisconnect at all — total silence.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('reconnect loop appears stuck'));
    expect(mockInstance.destroy).toHaveBeenCalledOnce();
    expect(mockInstance.login).toHaveBeenCalledTimes(2);
  });

  it('DMs the owner when the gateway reconnect loop appears stuck', async () => {
    const ownerAlerts = await import('./ownerAlerts.js');
    mod.startDiscordBot();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('reconnect appears stuck'));
  });

  it('does not force a reconnect while shard activity keeps arriving within the stall threshold', async () => {
    mod.startDiscordBot();
    const handler = findHandler('shardReconnecting');

    // A reconnect attempt every 90s (under the 120s threshold) resets the clock each time.
    await vi.advanceTimersByTimeAsync(90_000);
    handler(0);
    await vi.advanceTimersByTimeAsync(90_000);
    handler(0);
    await vi.advanceTimersByTimeAsync(90_000);

    expect(mockInstance.login).toHaveBeenCalledOnce();
  });

  it('does not force a reconnect once the client is fully connected, even after a long idle', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    await vi.advanceTimersByTimeAsync(600_000);

    expect(mockInstance.login).toHaveBeenCalledOnce();
  });

  it('forces a fresh login when a previously-ready client errors out and then goes silent', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(mod.getDiscordClient()).toBe(mockInstance);

    // getDiscordClient() stays non-null here (only shardDisconnect/stopDiscordBot clear it) — the
    // watchdog must key off actual gateway connectivity, not client existence, or it would never
    // fire for exactly this incident.
    const errorHandler = findHandler('shardError');
    errorHandler(new Error('Unexpected server response: 503'), 0);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('reconnect loop appears stuck'));
    expect(mockInstance.destroy).toHaveBeenCalledOnce();
    expect(mockInstance.login).toHaveBeenCalledTimes(2);
  });

  it('stops the watchdog on stopDiscordBot, so it does not fire after an intentional shutdown', async () => {
    mod.startDiscordBot();
    mod.stopDiscordBot();
    mockInstance.login.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockInstance.login).not.toHaveBeenCalled();
  });
});

// ─── startDiscordBot — login failure reconnect backoff ─────────────────────────
//
// A failed shardDisconnect self-heal (or the very first boot) must not leave the process
// permanently disconnected from Discord — startDiscordBot() schedules its own retry rather
// than requiring some other caller to notice and retry manually.

describe('startDiscordBot — login failure reconnect backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a retry when login fails, and eventually reconnects on its own', async () => {
    mockInstance.login.mockRejectedValueOnce(new Error('network unreachable'));
    mod.startDiscordBot();
    await flushMicrotasks();

    expect(mockLog.error).toHaveBeenCalledWith('Login failed:', expect.any(Error));
    expect(mod.getDiscordClient()).toBeNull();

    // First retry backs off 5s (RECONNECT_BASE_DELAY_MS).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(2);

    // This attempt succeeds — fire clientReady.
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(mod.getDiscordClient()).toBe(mockInstance);
  });

  it('backs off exponentially across repeated login failures, capped at the max delay', async () => {
    mockInstance.login.mockRejectedValue(new Error('still down'));
    mod.startDiscordBot();
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledTimes(1);

    // 5s, then 10s, then 20s — each attempt itself also rejects and reschedules.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(4);
  });

  it('does not stack a second pending retry when two login failures happen in quick succession', async () => {
    // Two failures back-to-back (e.g. two shardDisconnect events) must not schedule two
    // independent timers — that would double the reconnect attempts once both fire.
    mockInstance.login.mockRejectedValueOnce(new Error('first failure'));
    mod.startDiscordBot();
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledTimes(1);

    mockInstance.login.mockRejectedValueOnce(new Error('second failure'));
    mod.startDiscordBot();
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledTimes(2);

    // Only one retry timer should be pending — advancing past the base delay once fires exactly
    // one more attempt, not two.
    mockInstance.login.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(3);
  });

  it('resets the backoff after a successful reconnect, so a later failure starts from the base delay again', async () => {
    mockInstance.login.mockRejectedValueOnce(new Error('first failure'));
    mod.startDiscordBot();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5_000); // first retry, succeeds this time
    expect(mockInstance.login).toHaveBeenCalledTimes(2);
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(mod.getDiscordClient()).toBe(mockInstance);

    // A later shard disconnect forces a fresh login, which fails again — the backoff for this
    // new failure must start from RECONNECT_BASE_DELAY_MS again, not continue from where the
    // previous (already-recovered) failure episode left off.
    const disconnectHandler = mockInstance.on.mock.calls.find(([e]: string[]) => e === 'shardDisconnect')?.[1];
    mockInstance.login.mockRejectedValueOnce(new Error('second failure'));
    disconnectHandler({ code: 4004 }, 0);
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInstance.login).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending reconnect timer on stopDiscordBot, so the process does not log back in after being told to stop', async () => {
    mockInstance.login.mockRejectedValueOnce(new Error('network unreachable'));
    mod.startDiscordBot();
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledTimes(1);

    // A retry is scheduled but hasn't fired yet — stopping now must clear it, not just leave it
    // to fire into a process that was supposedly shut down.
    mod.stopDiscordBot();
    await vi.advanceTimersByTimeAsync(5 * 60_000); // past RECONNECT_MAX_DELAY_MS, so any surviving timer would have fired
    expect(mockInstance.login).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a reconnect when a login rejects after stopDiscordBot already stopped that attempt', async () => {
    const { promise: loginGate, reject: rejectLogin } = deferred<void>();
    mockInstance.login.mockReturnValueOnce(loginGate);
    mod.startDiscordBot();
    await flushMicrotasks();
    expect(mockInstance.login).toHaveBeenCalledOnce();

    // stopDiscordBot() clears bootingClient before the pending login ever settles.
    mod.stopDiscordBot();

    // The stale login now rejects — this must be a no-op: it belongs to an attempt the bot was
    // already told to stop, so it must not schedule a reconnect (which would restart a bot that
    // was just shut down).
    rejectLogin(new Error('network unreachable'));
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5 * 60_000); // past RECONNECT_MAX_DELAY_MS
    expect(mockInstance.login).toHaveBeenCalledOnce();
  });
});

// ─── stopDiscordBot ───────────────────────────────────────────────────────────

describe('stopDiscordBot', () => {
  it('does not throw when called before startDiscordBot (existing?.destroy is safe)', () => {
    expect(() => mod.stopDiscordBot()).not.toThrow();
    expect(mod.getDiscordClient()).toBeNull();
  });

  it('records the Discord connection as down', async () => {
    const healthStore = await import('../shared/healthStore.js');
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    mod.stopDiscordBot();

    expect(vi.mocked(healthStore.recordDiscordConnected)).toHaveBeenCalledWith(false);
  });

  it('calls destroy on the existing client and nulls the reference', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(mod.getDiscordClient()).not.toBeNull();

    mod.stopDiscordBot();

    expect(mod.getDiscordClient()).toBeNull();
    expect(mockInstance.destroy).toHaveBeenCalledOnce();
  });

  it('swallows errors thrown by destroy', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    mockInstance.destroy.mockRejectedValueOnce(new Error('destroy failed'));

    expect(() => mod.stopDiscordBot()).not.toThrow();
    expect(mod.getDiscordClient()).toBeNull();
    await flushMicrotasks();
  });

  it('destroys a booting client when stopDiscordBot is called before clientReady fires', () => {
    mod.startDiscordBot();
    expect(mod.getDiscordClient()).toBeNull();
    mod.stopDiscordBot();
    expect(mockInstance.destroy).toHaveBeenCalledOnce();
    expect(mod.getDiscordClient()).toBeNull();
  });

  it('discards a clientReady event that fires after stopDiscordBot', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    mod.stopDiscordBot();
    await readyCb(mockInstance); // fires late, after stop
    expect(mod.getDiscordClient()).toBeNull();
  });
});
