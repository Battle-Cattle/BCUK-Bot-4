import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/config', () => ({
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
}));

vi.mock('../../shared/healthStore', () => ({
  onHealthChanged: vi.fn(),
  getHealthSnapshot: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

vi.mock('../middleware', () => ({
  requireOwner: (req: any, res: any, next: any) => {
    if (req.session?.user?.isOwner) return next();
    res.status(403).json({ error: 'forbidden' });
  },
}));

import supertest from 'supertest';
import router from './healthStatusEvents';
import { onHealthChanged, getHealthSnapshot } from '../../shared/healthStore';
import { buildTestApp } from '../../test-utils/expressTestApp';

const OWNER_SESSION_USER = {
  discordId: '1',
  discordName: 'Owner',
  accessLevel: 3,
  currentGuildId: null,
  isOwner: true,
  guilds: [],
};

const NON_OWNER_SESSION_USER = { ...OWNER_SESSION_USER, isOwner: false };

// Captured once at module load, mirroring dashboardStatusEvents.test.ts's pattern — this
// module registers its listener as a top-level side effect, not per-request.
const registeredListener = vi.mocked(onHealthChanged).mock.calls[0]?.[0] as () => void;

function buildApp(sessionUser: unknown) {
  return buildTestApp({ router, sessionUser });
}

beforeEach(() => {
  vi.mocked(getHealthSnapshot).mockReturnValue({ discordConnected: true } as any);
});

describe('GET /events — auth', () => {
  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER)).get('/events');
    expect(res.status).toBe(403);
  });

  it('blocks an unauthenticated request with a 403', async () => {
    const res = await supertest(buildApp(undefined)).get('/events');
    expect(res.status).toBe(403);
  });
});

describe('pushHealthUpdate (registered onHealthChanged listener)', () => {
  it('registers a listener at module load', () => {
    expect(registeredListener).toBeTypeOf('function');
  });

  it('does not throw when there are no connected clients', () => {
    expect(() => registeredListener()).not.toThrow();
  });
});

describe('GET /events — initial snapshot push', () => {
  /**
   * Opens an SSE connection and resolves once the first `data:` frame has been written,
   * leaving the stream open.
   * @returns The response status, the SSE body received so far, and a `close()` callback that
   * emits `'close'` on the underlying request so the test can release the connection.
   */
  function connect(): Promise<{ status: number; body: string; close: () => void }> {
    const req = supertest(buildApp(OWNER_SESSION_USER)).get('/events');
    return new Promise((resolve) => {
      let body = '';
      req
        .buffer(false)
        .parse((res, _cb) => {
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.includes('data:')) {
              resolve({ status: res.statusCode ?? 0, body, close: () => (res as any).req.emit('close') });
            }
          });
          (res as any).resume();
        })
        .end();
    });
  }

  it('pushes the current snapshot immediately once a connection is accepted', async () => {
    vi.mocked(getHealthSnapshot).mockReturnValue({ discordConnected: true, marker: 'initial-push' } as any);
    const { status, body, close } = await connect();
    expect(status).toBe(200);
    expect(body).toContain('initial-push');
    close();
  });
});
