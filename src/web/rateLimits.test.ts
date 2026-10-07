import { createHash } from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import supertest from 'supertest';
import type { SessionUser } from '../types/express';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

vi.mock('../db/users', () => ({ AccessLevel: ACCESS_LEVEL_MOCK }));

import { AccessLevel } from '../db/users';
import {
  ipKey,
  generalLimiterSkip,
  sessionLimiterKey,
  sessionLimiterSkip,
  streamdeckLimiterKey,
  streamdeckAuthFailureLimiter,
  streamdeckAuthFailureWasSuccessful,
} from './rateLimits';

const authedUser: SessionUser = {
  discordId: '123456789',
  discordName: 'TestUser',
  discordAvatar: null,
  isOwner: false,
  accessLevel: AccessLevel.USER,
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
  it('returns the SHA-256 hash of the Bearer token when a valid Authorization header is present', () => {
    const expected = createHash('sha256').update('my-secret-token').digest('hex');
    expect(streamdeckLimiterKey(makeReq({ authHeader: 'Bearer my-secret-token' }))).toBe(expected);
  });

  it('keys different tokens to different hash buckets', () => {
    const key1 = streamdeckLimiterKey(makeReq({ authHeader: 'Bearer token-a' }));
    const key2 = streamdeckLimiterKey(makeReq({ authHeader: 'Bearer token-b' }));
    expect(key1).not.toBe(key2);
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

describe('streamdeckAuthFailureWasSuccessful', () => {
  it('treats only a 401 as a failure', () => {
    const req = {} as Request;
    expect(streamdeckAuthFailureWasSuccessful(req, { statusCode: 401 } as Response)).toBe(false);
    expect(streamdeckAuthFailureWasSuccessful(req, { statusCode: 200 } as Response)).toBe(true);
    expect(streamdeckAuthFailureWasSuccessful(req, { statusCode: 403 } as Response)).toBe(true);
    expect(streamdeckAuthFailureWasSuccessful(req, { statusCode: 500 } as Response)).toBe(true);
  });
});

describe('streamdeckAuthFailureLimiter', () => {
  // Mirrors requireApiKey: 401 for anything but the one valid token. The limiter's MemoryStore is
  // module-level, so each test uses its own client IP (via X-Forwarded-For) to get a fresh bucket.
  function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/streamdeck', streamdeckAuthFailureLimiter, (req, res) => {
      if (req.headers['authorization'] === 'Bearer valid-key') res.json({ ok: true });
      else res.status(401).json({ ok: false, error: 'Unauthorized' });
    });
    return app;
  }

  it('429s an IP that keeps sending random tokens, even though each token is different', async () => {
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await supertest(app)
        .get('/api/streamdeck/sfx')
        .set('X-Forwarded-For', '198.51.100.1')
        .set('Authorization', `Bearer random-${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('does not count a valid key\'s successful requests', async () => {
    const app = buildApp();
    for (let i = 0; i < 40; i++) {
      const res = await supertest(app)
        .get('/api/streamdeck/sfx')
        .set('X-Forwarded-For', '198.51.100.2')
        .set('Authorization', 'Bearer valid-key');
      expect(res.status).toBe(200);
    }
  });
});
