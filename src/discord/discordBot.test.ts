import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/config', () => ({
  DISCORD_TOKEN: 'mock-token',
  DISCORD_GUILD_ID: 'guild-id',
  DISCORD_VOICE_CHANNEL_ID: 'vc-id',
  SFX_FOLDER: '/tmp/sfx',
  OVERLAY_FOLDER: '/tmp/overlay',
  GLOBAL_COOLDOWN_MS: 0,
  EVENTSUB_TOKEN_SECRET: undefined,
}));
vi.mock('../commands/commandRouter', () => ({ handleCommand: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/customCommandHandler', () => ({ executeCustomCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/counterHandler', () => ({ executeCounterCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/statusStore', () => ({ setDiscordReady: vi.fn() }));
vi.mock('./guildRegistry', () => ({
  // Only the legacy configured guild is registered in these tests.
  isRegisteredGuild: vi.fn((id: string) => id === 'guild-id'),
  reloadGuildRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db/guilds', () => ({ upsertGuild: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('discord.js', () => ({
  Client: vi.fn(),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 8 },
}));

type DiscordBotModule = typeof import('./discordBot');
type CommandRouterModule = typeof import('../commands/commandRouter');
type CustomCommandModule = typeof import('../commands/customCommandHandler');

let mod: DiscordBotModule;
let commands: CommandRouterModule;
let customCmds: CustomCommandModule;
let mockInstance: ReturnType<typeof makeMockClient>;
let mockGuild: { name: string; members: { fetch: ReturnType<typeof vi.fn> } };

function makeMockClient() {
  mockGuild = { name: 'TestGuild', members: { fetch: vi.fn().mockResolvedValue({ displayName: 'Alice' }) } };
  return {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    user: { tag: 'Bot#1234' },
    guilds: {
      cache: { get: vi.fn().mockReturnValue(null) },
      fetch: vi.fn().mockResolvedValue(mockGuild),
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  mockInstance = makeMockClient();
  const djs = await import('discord.js');
  vi.mocked(djs.Client).mockImplementation(function () { return mockInstance; } as any);
  // Import commandRouter first so discordBot.ts picks up the same cached instance
  commands = await import('../commands/commandRouter.js') as CommandRouterModule;
  customCmds = await import('../commands/customCommandHandler.js') as CustomCommandModule;
  mod = await import('./discordBot.js') as DiscordBotModule;
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

// ─── fetchMemberDisplayName ───────────────────────────────────────────────────

describe('fetchMemberDisplayName', () => {
  it('returns null when client is not ready', async () => {
    expect(await mod.fetchMemberDisplayName('123')).toBeNull();
  });

  it('returns the member displayName when client is ready and fetch succeeds', async () => {
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);  // fires clientReady → sets client and cachedGuild

    const result = await mod.fetchMemberDisplayName('user123');
    expect(result).toBe('Alice');
  });

  it('returns null when guild member fetch throws', async () => {
    mockGuild.members.fetch.mockRejectedValueOnce(new Error('not found'));
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);

    const result = await mod.fetchMemberDisplayName('missing');
    expect(result).toBeNull();
  });
});

// ─── startDiscordBot — messageCreate handler ──────────────────────────────────

describe('startDiscordBot — messageCreate handler', () => {
  function getMessageCreateCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'messageCreate')?.[1] as Function;
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

  it('skips DMs (no guildId)', () => {
    const cb = getMessageCreateCb();
    cb({ author: { bot: false, username: 'Alice' }, guildId: null, content: '!test', member: null });
    expect(vi.mocked(commands.handleCommand)).not.toHaveBeenCalled();
  });

  it('dispatches to command handlers for registered guild messages', () => {
    const cb = getMessageCreateCb();
    const msg = { author: { bot: false, username: 'Alice' }, guildId: 'guild-id', content: '!test', member: { displayName: 'Alice' } };
    cb(msg);
    expect(vi.mocked(commands.handleCommand)).toHaveBeenCalledWith('!test', 'discord');
    expect(vi.mocked(customCmds.executeCustomCommandForDiscord)).toHaveBeenCalledWith(msg, 'Alice');
  });
});

// ─── startDiscordBot — guildCreate handler ────────────────────────────────────

describe('startDiscordBot — guildCreate handler', () => {
  function getGuildCreateCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'guildCreate')?.[1] as Function;
  }

  it('registers the guild row and reloads the registry (no auto-whitelist)', async () => {
    const guilds = await import('../db/guilds.js');
    const registry = await import('./guildRegistry.js');
    const cb = getGuildCreateCb();

    await cb({ id: 'new-guild', name: 'New Server' });
    // Let the upsert → reload promise chain settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.upsertGuild)).toHaveBeenCalledWith('new-guild', 'New Server');
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();
  });
});

// ─── startDiscordBot — clientReady error path ─────────────────────────────────

describe('startDiscordBot — clientReady error path', () => {
  it('catches guild fetch errors without crashing', async () => {
    mockInstance.guilds.fetch.mockRejectedValueOnce(new Error('guild unavailable'));
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await expect(readyCb(mockInstance)).resolves.toBeUndefined();
  });
});

// ─── startDiscordBot — error event ───────────────────────────────────────────

describe('startDiscordBot — error event', () => {
  it('registers an error handler that does not throw', () => {
    mod.startDiscordBot();
    const errorCb = mockInstance.on.mock.calls.find(([event]: string[]) => event === 'error')?.[1] as Function;
    expect(() => errorCb(new Error('ws error'))).not.toThrow();
  });
});

// ─── stopDiscordBot ───────────────────────────────────────────────────────────

describe('stopDiscordBot', () => {
  it('does not throw when called before startDiscordBot (existing?.destroy is safe)', () => {
    expect(() => mod.stopDiscordBot()).not.toThrow();
    expect(mod.getDiscordClient()).toBeNull();
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
    mockInstance.destroy.mockImplementationOnce(() => { throw new Error('destroy failed'); });

    expect(() => mod.stopDiscordBot()).not.toThrow();
    expect(mod.getDiscordClient()).toBeNull();
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
