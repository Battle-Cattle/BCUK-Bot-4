import { describe, it, expect } from 'vitest';
import { getSessionUser } from './session';

function makeReq(overrides: object = {}): any {
  return {
    session: {},
    ...overrides,
  };
}

describe('getSessionUser', () => {
  it('returns the session user when present', () => {
    const user = { discordId: '1', accessLevel: 0 };
    const req = makeReq({ session: { user } });
    expect(getSessionUser(req)).toBe(user);
  });

  it('throws when session.user is absent', () => {
    const req = makeReq({ session: {} });
    expect(() => getSessionUser(req)).toThrow(/authenticated session/);
  });
});
