import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ OVERLAY_STATUS_MAX_SSE_PER_STREAMER: 2, SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
vi.mock('../session', () => ({ getSessionUser: (req: any) => ({ discordId: req.discordId }) }));
const entries = vi.fn();
const conns = vi.hoisted(() => ({ sharedConnections: new Map<string, Set<unknown>>() }));
vi.mock('./sharedOverlaySource', () => ({ getSharedVideoEntries: () => entries(), sharedConnections: conns.sharedConnections }));

import { router, readinessConnections } from './sharedOverlayReadinessStream';
import { recordReadinessReport, resetReadiness } from './sharedOverlayReadiness';

/** The stream route's handler. */
const handler = (router as any).stack.find((l: any) => l.route?.path === '/readiness/events').route.stack[0].handle;

/** A fake SSE response and request for a Manager. */
function fake(discordId: string) {
  const res: any = {
    setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(),
    status: vi.fn().mockReturnThis(), writableLength: 0, closed: false,
  };
  return { req: { discordId, ip: '1.1.1.1', destroyed: false, on: vi.fn() } as any, res };
}

/** Snapshots written to a fake response. */
const snapshots = (res: any) => res.write.mock.calls
  .map((c: any[]) => String(c[0])).filter((s: string) => s.startsWith('data: ')).map((s: string) => JSON.parse(s.slice(6)));

beforeEach(() => {
  readinessConnections.clear();
  conns.sharedConnections.clear();
  resetReadiness();
  entries.mockResolvedValue([{ id: 1, name: 'Clap' }]);
});

describe('GET /readiness/events', () => {
  it('sends a snapshot on connect', async () => {
    conns.sharedConnections.set('alice', new Set());
    const { req, res } = fake('m1');
    await handler(req, res);
    expect(snapshots(res)[0]).toMatchObject({ overlays: [{ login: 'alice', online: true }], videos: [{ id: 1 }] });
  });

  it('pushes an update to every open stream when a report arrives', async () => {
    conns.sharedConnections.set('alice', new Set());
    const a = fake('m1');
    const b = fake('m2');
    await handler(a.req, a.res);
    await handler(b.req, b.res);
    recordReadinessReport('alice', { stored: [1], downloading: null });
    await vi.waitFor(() => expect(snapshots(a.res)).toHaveLength(2));
    expect(snapshots(b.res)).toHaveLength(2);
    expect(snapshots(a.res)[1].videos[0]).toMatchObject({ ready: 1, allReady: true });
  });

  it('limits streams per Manager', async () => {
    for (let i = 0; i < 2; i++) await handler(fake('m1').req, fake('m1').res);
    const third = fake('m1');
    await handler(third.req, third.res);
    expect(third.res.status).toHaveBeenCalledWith(429);
  });

  it('answers 500 when the first snapshot cannot be built', async () => {
    entries.mockRejectedValue(new Error('db'));
    const { req, res } = fake('m1');
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(readinessConnections.size).toBe(0);
  });
});
