import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../commands/customCommandHandler', () => ({ executeCustomCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../commands/counterHandler', () => ({ executeCounterCommandForDiscord: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/statusStore', () => ({ setDiscordReady: vi.fn(), clearVoiceStatus: vi.fn() }));
vi.mock('../audio/audioPlayer', () => ({ forgetGuild: vi.fn() }));
vi.mock('../web/routes/adminRefresh', () => ({ forgetGuildRefreshState: vi.fn() }));
vi.mock('./guildRegistry', () => ({
  // Only the legacy configured guild is registered in these tests.
  isRegisteredGuild: vi.fn((id: string) => id === 'guild-id'),
  reloadGuildRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db', () => ({
  upsertGuild: vi.fn().mockResolvedValue(undefined),
  getAllGuilds: vi.fn().mockResolvedValue([{ guild_id: 'guild-id', name: 'TestGuild', voice_channel_id: null }]),
  getGuildById: vi.fn().mockResolvedValue(null),
  findUser: vi.fn().mockResolvedValue(null),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  setMemberAccessLevel: vi.fn().mockResolvedValue(undefined),
  AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));
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
  // vi.mock() creates one shared mock instance per factory; resetModules clears the
  // module cache but not call counts, so clearAllMocks() is needed before each test.
  vi.clearAllMocks();
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
    expect(vi.mocked(commands.handleCommand)).toHaveBeenCalledWith('!test', 'discord', 'guild-id');
    expect(vi.mocked(customCmds.executeCustomCommandForDiscord)).toHaveBeenCalledWith(msg, 'Alice', 'guild-id');
  });
});

// ─── startDiscordBot — guildCreate handler ────────────────────────────────────

describe('startDiscordBot — guildCreate handler', () => {
  function getGuildCreateCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'guildCreate')?.[1] as Function;
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
});

// ─── startDiscordBot — guildDelete handler ────────────────────────────────────

describe('startDiscordBot — guildDelete handler', () => {
  function getGuildDeleteCb() {
    mod.startDiscordBot();
    return mockInstance.on.mock.calls.find(([event]: string[]) => event === 'guildDelete')?.[1] as Function;
  }

  it('forgets the departed guild\'s in-memory voice, command, status, and refresh state', async () => {
    const audioPlayer = await import('../audio/audioPlayer.js');
    const status = await import('../shared/statusStore.js');
    const adminRefresh = await import('../web/routes/adminRefresh.js');
    const cb = getGuildDeleteCb();

    cb({ id: 'departed-guild', name: 'Departed Server' });

    expect(vi.mocked(audioPlayer.forgetGuild)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(commands.forgetGuildCommandState)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(status.clearVoiceStatus)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(adminRefresh.forgetGuildRefreshState)).toHaveBeenCalledWith('departed-guild');
  });

  it('does not touch the guild DB row', async () => {
    const guilds = await import('../db.js');
    const cb = getGuildDeleteCb();

    cb({ id: 'departed-guild', name: 'Departed Server' });

    expect(vi.mocked(guilds.upsertGuild)).not.toHaveBeenCalled();
  });
});

// ─── startDiscordBot — clientReady error path ─────────────────────────────────

describe('startDiscordBot — clientReady error path', () => {
  it('catches getAllGuilds errors without crashing', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAllGuilds).mockRejectedValueOnce(new Error('guild unavailable'));
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await expect(readyCb(mockInstance)).resolves.toBeUndefined();
  });

  it('sets ready state with DB guild names on clientReady success', async () => {
    const status = await import('../shared/statusStore.js');
    mod.startDiscordBot();
    const readyCb = mockInstance.once.mock.calls.find(([event]: string[]) => event === 'clientReady')?.[1];
    await readyCb(mockInstance);
    expect(vi.mocked(status.setDiscordReady)).toHaveBeenCalledWith('Bot#1234', 'TestGuild');
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
