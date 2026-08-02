import { describe, it, expect, vi } from 'vitest';

// `fixtures.ts` imports `AccessLevel` from `../db` at runtime, which transitively pulls in
// `../db/pool` (and its required env vars). Mock it out, matching the convention used across
// `src/web/routes/*.test.ts` (e.g. `shared.test.ts`).
vi.mock('../db', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import { makeSessionUser, makeDbGuild } from './fixtures';
import { AccessLevel } from '../db';

describe('makeSessionUser', () => {
  it('returns a default level-0 test user when called with no overrides', () => {
    expect(makeSessionUser()).toEqual({
      discordId: '100000000000000001',
      discordName: 'TestUser',
      discordAvatar: null,
      accessLevel: AccessLevel.USER,
    });
  });

  it('applies overrides on top of the defaults', () => {
    const user = makeSessionUser({ accessLevel: AccessLevel.ADMIN, currentGuildId: 'g1', isOwner: true });
    expect(user).toEqual({
      discordId: '100000000000000001',
      discordName: 'TestUser',
      discordAvatar: null,
      accessLevel: AccessLevel.ADMIN,
      currentGuildId: 'g1',
      isOwner: true,
    });
  });
});

describe('makeDbGuild', () => {
  it('returns a default guild row with a null voice channel when called with no overrides', () => {
    expect(makeDbGuild()).toEqual({
      guild_id: '900000000000000001',
      name: 'Test Guild',
      voice_channel_id: null,
    });
  });

  it('applies overrides on top of the defaults', () => {
    expect(makeDbGuild({ guild_id: '42', voice_channel_id: '99' })).toEqual({
      guild_id: '42',
      name: 'Test Guild',
      voice_channel_id: '99',
    });
  });
});
