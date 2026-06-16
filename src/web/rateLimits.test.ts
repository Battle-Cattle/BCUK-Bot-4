import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import type { SessionUser } from '../types/express';
import {
  ipKey,
  generalLimiterSkip,
  sessionLimiterKey,
  sessionLimiterSkip,
  streamdeckLimiterKey,
} from './rateLimits';

const authedUser: SessionUser = {
  discordId: '123456789',
  discordName: 'TestUser',
  discordAvatar: null,
  isOwner: false,
  accessLevel: 0,
  currentGuildId: '999000999000999000',
  guilds: [{ guildId: '999000999000999000', name: 'Test Guild' }],
};

function makeReq(overrides: Partial<{
  path: string;
  ip: string;
  sessionUser: SessionUser | undefined;
  authHeader: string | undefined;
  socketRemoteAddress: string | undefined;
}>): Request {
  const { path = '/dashboard', ip = '1.2.3.4', sessionUser, authHeader, socketRemoteAddress } = overrides;
  return {
    path,
    ip,
    socket: { remoteAddress: socketRemoteAddress },
    session: { user: sessionUser } as Request['session'],
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// ipKey
// ---------------------------------------------------------------------------
describe('ipKey', () => {
  it('returns req.ip when present', () => {
    expect(ipKey(makeReq({ ip: '10.0.0.1' }))).toBe('10.0.0.1');
  });

  it('falls back to socket.remoteAddress when req.ip is undefined', () => {
    const req = { ip: undefined, socket: { remoteAddress: '192.168.1.1' } } as unknown as Request;
    expect(ipKey(req)).toBe('192.168.1.1');
  });

  it('returns "unknown" when both ip and socket.remoteAddress are absent', () => {
    const req = { ip: undefined, socket: { remoteAddress: undefined } } as unknown as Request;
    expect(ipKey(req)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// generalLimiterSkip
// ---------------------------------------------------------------------------
describe('generalLimiterSkip', () => {
  it('skips (true) for unauthenticated request to /api/streamdeck path', () => {
    expect(generalLimiterSkip(makeReq({ path: '/api/streamdeck/sfx', sessionUser: undefined }))).toBe(true);
  });

  it('skips (true) for authenticated request to /api/streamdeck path', () => {
    expect(generalLimiterSkip(makeReq({ path: '/api/streamdeck/voice/join', sessionUser: authedUser }))).toBe(true);
  });

  it('skips (true) for an authenticated request to a non-streamdeck path', () => {
    expect(generalLimiterSkip(makeReq({ path: '/dashboard', sessionUser: authedUser }))).toBe(true);
  });

  it('does NOT skip (false) for an unauthenticated request to a non-streamdeck path', () => {
    expect(generalLimiterSkip(makeReq({ path: '/dashboard', sessionUser: undefined }))).toBe(false);
  });

  it('does NOT skip (false) for an unauthenticated request to /api (non-streamdeck)', () => {
    expect(generalLimiterSkip(makeReq({ path: '/api/status', sessionUser: undefined }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionLimiterSkip
// ---------------------------------------------------------------------------
describe('sessionLimiterSkip', () => {
  it('skips (true) for /api/streamdeck path even when authenticated', () => {
    expect(sessionLimiterSkip(makeReq({ path: '/api/streamdeck/sfx', sessionUser: authedUser }))).toBe(true);
  });

  it('skips (true) for unauthenticated request to non-streamdeck path', () => {
    expect(sessionLimiterSkip(makeReq({ path: '/dashboard', sessionUser: undefined }))).toBe(true);
  });

  it('skips (true) for unauthenticated request to /api/streamdeck path', () => {
    expect(sessionLimiterSkip(makeReq({ path: '/api/streamdeck/sfx', sessionUser: undefined }))).toBe(true);
  });

  it('does NOT skip (false) for authenticated request to non-streamdeck path', () => {
    expect(sessionLimiterSkip(makeReq({ path: '/dashboard', sessionUser: authedUser }))).toBe(false);
  });

  it('does NOT skip (false) for authenticated request to /api/status', () => {
    expect(sessionLimiterSkip(makeReq({ path: '/api/status', sessionUser: authedUser }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionLimiterKey
// ---------------------------------------------------------------------------
describe('sessionLimiterKey', () => {
  it('returns the Discord ID for authenticated requests', () => {
    expect(sessionLimiterKey(makeReq({ sessionUser: authedUser }))).toBe('123456789');
  });

  it('returns "__unauthenticated__" when there is no session user', () => {
    expect(sessionLimiterKey(makeReq({ sessionUser: undefined }))).toBe('__unauthenticated__');
  });

  it('keys different users to different buckets', () => {
    const userA = { ...authedUser, discordId: 'aaa' };
    const userB = { ...authedUser, discordId: 'bbb' };
    expect(sessionLimiterKey(makeReq({ sessionUser: userA }))).not.toBe(
      sessionLimiterKey(makeReq({ sessionUser: userB })),
    );
  });
});

// ---------------------------------------------------------------------------
// streamdeckLimiterKey
// ---------------------------------------------------------------------------
describe('streamdeckLimiterKey', () => {
  it('returns the Bearer token when a valid Authorization header is present', () => {
    expect(streamdeckLimiterKey(makeReq({ authHeader: 'Bearer my-secret-token' }))).toBe('my-secret-token');
  });

  it('falls back to req.ip when no Authorization header is present', () => {
    expect(streamdeckLimiterKey(makeReq({ ip: '5.6.7.8', authHeader: undefined }))).toBe('5.6.7.8');
  });

  it('falls back to req.ip when Authorization header is not a Bearer token', () => {
    expect(streamdeckLimiterKey(makeReq({ ip: '5.6.7.8', authHeader: 'Basic dXNlcjpwYXNz' }))).toBe('5.6.7.8');
  });

  it('falls back to socket.remoteAddress when req.ip is absent', () => {
    const req = {
      ip: undefined,
      socket: { remoteAddress: '9.10.11.12' },
      headers: {},
    } as unknown as Request;
    expect(streamdeckLimiterKey(req)).toBe('9.10.11.12');
  });

  it('returns "unknown" when no IP source and no Bearer token are available', () => {
    const req = {
      ip: undefined,
      socket: { remoteAddress: undefined },
      headers: {},
    } as unknown as Request;
    expect(streamdeckLimiterKey(req)).toBe('unknown');
  });
});
