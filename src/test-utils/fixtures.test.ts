import { describe, it, expect } from 'vitest';
import { makeSessionUser, makeDbGuild } from './fixtures';

describe('makeSessionUser', () => {
  it('returns a default level-0 test user when called with no overrides', () => {
    expect(makeSessionUser()).toEqual({
      discordId: '100000000000000001',
      discordName: 'TestUser',
      discordAvatar: null,
      accessLevel: 0,
    });
  });

  it('applies overrides on top of the defaults', () => {
    const user = makeSessionUser({ accessLevel: 3, currentGuildId: 'g1', isOwner: true });
    expect(user).toEqual({
      discordId: '100000000000000001',
      discordName: 'TestUser',
      discordAvatar: null,
      accessLevel: 3,
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
