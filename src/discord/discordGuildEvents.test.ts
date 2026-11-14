import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';
import { flushMicrotasks } from '../test-utils/flushMicrotasks';
import { deferred } from '../test-utils/deferredPromise';

vi.mock('../shared/config', () => ({
  // The guilds the guildCreate tests treat as allowlisted for auto-provisioning.
  DISCORD_AUTO_PROVISION_GUILD_IDS: new Set(['new-guild', 'guild-a', 'guild-b']),
}));
vi.mock('../commands/commandRouter', () => ({ forgetGuildCommandState: vi.fn() }));
vi.mock('../commands/customCommandHandler', () => ({ forgetGuildCustomCommandCooldown: vi.fn() }));
vi.mock('../commands/counterHandler', () => ({ forgetGuildCounterCooldown: vi.fn() }));
vi.mock('../shared/statusStore', () => ({ clearVoiceStatus: vi.fn() }));
vi.mock('../audio/audioPlayer', () => ({ forgetGuild: vi.fn() }));
vi.mock('./guildRefreshState', () => ({ forgetGuildRefreshState: vi.fn() }));
vi.mock('./ownerAlerts', () => ({ sendOwnerAlert: vi.fn().mockResolvedValue(true) }));
vi.mock('./guildRegistry', () => ({ reloadGuildRegistry: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../db', () => ({
  upsertGuild: vi.fn().mockResolvedValue(undefined),
  getGuildById: vi.fn().mockResolvedValue(null),
  findUser: vi.fn().mockResolvedValue(null),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  setMemberAccessLevel: vi.fn().mockResolvedValue(undefined),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
// One shared logger instance, so tests can assert on the lines this module logs.
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../shared/logger', () => ({ createLogger: () => mockLog }));

import { upsertGuild, getGuildById, findUser, upsertUser, setMemberAccessLevel } from '../db';
import { forgetGuildCommandState } from '../commands/commandRouter';
import { forgetGuildCustomCommandCooldown } from '../commands/customCommandHandler';
import { registerGuildCreateHandler, registerGuildDeleteHandler } from './discordGuildEvents';

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, and some tests below replace these for good, so restore
  // the defaults each test starts from.
  vi.mocked(upsertGuild).mockReset().mockResolvedValue(undefined);
  vi.mocked(getGuildById).mockReset().mockResolvedValue(null);
  vi.mocked(findUser).mockReset().mockResolvedValue(null);
  vi.mocked(upsertUser).mockReset().mockResolvedValue(undefined);
  vi.mocked(setMemberAccessLevel).mockReset().mockResolvedValue(undefined);
});

describe('registerGuildCreateHandler', () => {
  function getGuildCreateCb() {
    const client = { on: vi.fn() };
    registerGuildCreateHandler(client as any);
    return client.on.mock.calls.find(([event]: string[]) => event === 'guildCreate')?.[1] as (...args: any[]) => unknown;
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
    expect(vi.mocked(guilds.upsertUser)).toHaveBeenCalledWith('owner-id', 'OwnerName');
    expect(vi.mocked(guilds.setMemberAccessLevel)).toHaveBeenCalledWith('new-guild', 'owner-id', guilds.AccessLevel.ADMIN);
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();

    const [upsertOrder] = vi.mocked(guilds.upsertGuild).mock.invocationCallOrder;
    const [grantOrder] = vi.mocked(guilds.setMemberAccessLevel).mock.invocationCallOrder;
    const [reloadOrder] = vi.mocked(registry.reloadGuildRegistry).mock.invocationCallOrder;
    expect(upsertOrder).toBeLessThan(grantOrder!);
    expect(grantOrder).toBeLessThan(reloadOrder!);
  });

  it('leaves a brand-new guild that is not allowlisted unprovisioned and alerts the bot owner', async () => {
    const guilds = await import('../db.js');
    const registry = await import('./guildRegistry.js');
    const ownerAlerts = await import('./ownerAlerts.js');
    const guild = { ...makeNewGuild(), id: 'stranger-guild', name: 'Stranger Server' };
    const cb = getGuildCreateCb();

    await cb(guild);
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(guilds.upsertGuild)).toHaveBeenCalledWith('stranger-guild', 'Stranger Server');
    expect(guild.fetchOwner).not.toHaveBeenCalled();
    expect(vi.mocked(guilds.upsertUser)).not.toHaveBeenCalled();
    expect(vi.mocked(guilds.setMemberAccessLevel)).not.toHaveBeenCalled();
    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();
    expect(vi.mocked(ownerAlerts.sendOwnerAlert)).toHaveBeenCalledWith(expect.stringContaining('stranger-guild'));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('not on DISCORD_AUTO_PROVISION_GUILD_IDS'));
  });

  it('does not wait for the owner alert before reloading the registry for a guild left unprovisioned', async () => {
    const registry = await import('./guildRegistry.js');
    const ownerAlerts = await import('./ownerAlerts.js');
    vi.mocked(ownerAlerts.sendOwnerAlert).mockReturnValueOnce(new Promise(() => { /* never settles */ }));
    const cb = getGuildCreateCb();

    await cb({ ...makeNewGuild(), id: 'stranger-guild' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(vi.mocked(registry.reloadGuildRegistry)).toHaveBeenCalled();
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

describe('registerGuildDeleteHandler', () => {
  function getGuildDeleteCb() {
    const client = { on: vi.fn() };
    registerGuildDeleteHandler(client as any);
    return client.on.mock.calls.find(([event]: string[]) => event === 'guildDelete')?.[1] as (...args: any[]) => unknown;
  }

  it('forgets the departed guild\'s in-memory voice, command, cooldown, status, and refresh state', async () => {
    const audioPlayer = await import('../audio/audioPlayer.js');
    const status = await import('../shared/statusStore.js');
    const guildRefreshState = await import('./guildRefreshState.js');
    const counterHandler = await import('../commands/counterHandler.js');
    const cb = getGuildDeleteCb();

    cb({ id: 'departed-guild', name: 'Departed Server' });

    expect(vi.mocked(audioPlayer.forgetGuild)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(forgetGuildCommandState)).toHaveBeenCalledWith('departed-guild');
    expect(vi.mocked(forgetGuildCustomCommandCooldown)).toHaveBeenCalledWith('departed-guild');
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
