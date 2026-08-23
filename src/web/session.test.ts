import { describe, it, expect } from 'vitest';
import { getSessionUser, getCurrentGuildId } from './session';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

/** Builds a minimal fake Express request for exercising `getSessionUser`. */
function makeReq(overrides: object = {}): any {
  return {
    session: {},
    ...overrides,
  };
}

describe('getSessionUser', () => {
  it('returns the session user when present', () => {
    const user = { discordId: '1', accessLevel: ACCESS_LEVEL_MOCK.USER };
    const req = makeReq({ session: { user } });
    expect(getSessionUser(req)).toBe(user);
  });

  it('throws when session.user is absent', () => {
    const req = makeReq({ session: {} });
    expect(() => getSessionUser(req)).toThrow(/authenticated session/);
  });
});

describe('getCurrentGuildId', () => {
  it('returns the selected guild id when present', () => {
    const user = { discordId: '1', accessLevel: ACCESS_LEVEL_MOCK.USER, currentGuildId: 'g1' };
    const req = makeReq({ session: { user } });
    expect(getCurrentGuildId(req)).toBe('g1');
  });

  it('throws when currentGuildId is null', () => {
    const user = { discordId: '1', accessLevel: ACCESS_LEVEL_MOCK.USER, currentGuildId: null };
    const req = makeReq({ session: { user } });
    expect(() => getCurrentGuildId(req)).toThrow(/selected guild/);
  });

  it('throws when session.user is absent', () => {
    const req = makeReq({ session: {} });
    expect(() => getCurrentGuildId(req)).toThrow(/authenticated session/);
  });
});
