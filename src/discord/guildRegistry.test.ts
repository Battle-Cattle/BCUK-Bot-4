import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../db', () => ({ getProvisionedGuilds: vi.fn() }));

import { getProvisionedGuilds } from '../db';
import {
  reloadGuildRegistry,
  isRegisteredGuild,
  getRegisteredGuild,
  getRegisteredGuildIds,
  getRegisteredGuilds,
  __resetGuildRegistryForTests,
} from './guildRegistry';

beforeEach(() => {
  vi.clearAllMocks();
  __resetGuildRegistryForTests();
});

describe('reloadGuildRegistry', () => {
  it('loads guilds from the DB into the registry', async () => {
    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '111', name: 'Alpha', voice_channel_id: '222' },
      { guild_id: '333', name: 'Beta', voice_channel_id: null },
    ]);

    await reloadGuildRegistry();

    expect(isRegisteredGuild('111')).toBe(true);
    expect(isRegisteredGuild('333')).toBe(true);
    expect(getRegisteredGuildIds()).toEqual(['111', '333']);
  });

  it('replaces the previous registry contents on reload', async () => {
    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '111', name: 'Alpha', voice_channel_id: null },
    ]);
    await reloadGuildRegistry();
    expect(isRegisteredGuild('111')).toBe(true);

    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '999', name: 'Gamma', voice_channel_id: null },
    ]);
    await reloadGuildRegistry();

    expect(isRegisteredGuild('111')).toBe(false);
    expect(isRegisteredGuild('999')).toBe(true);
  });

  it('leaves the previous registry intact when the DB read fails', async () => {
    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '111', name: 'Alpha', voice_channel_id: null },
    ]);
    await reloadGuildRegistry();

    vi.mocked(getProvisionedGuilds).mockRejectedValueOnce(new Error('db down'));
    await expect(reloadGuildRegistry()).rejects.toThrow('db down');

    expect(isRegisteredGuild('111')).toBe(true);
  });
});

describe('isRegisteredGuild', () => {
  it('returns false for unknown guilds', () => {
    expect(isRegisteredGuild('nope')).toBe(false);
  });
});

describe('getRegisteredGuild', () => {
  it('returns the cached config for a known guild', async () => {
    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '111', name: 'Alpha', voice_channel_id: '222' },
    ]);
    await reloadGuildRegistry();

    expect(getRegisteredGuild('111')).toEqual({ guild_id: '111', name: 'Alpha', voice_channel_id: '222' });
    expect(getRegisteredGuild('nope')).toBeUndefined();
  });
});

describe('getRegisteredGuilds', () => {
  it('returns every cached guild config', async () => {
    vi.mocked(getProvisionedGuilds).mockResolvedValueOnce([
      { guild_id: '111', name: 'Alpha', voice_channel_id: null },
      { guild_id: '333', name: 'Beta', voice_channel_id: null },
    ]);
    await reloadGuildRegistry();

    expect(getRegisteredGuilds()).toHaveLength(2);
    expect(getRegisteredGuilds().map((g) => g.guild_id)).toEqual(['111', '333']);
  });
});
