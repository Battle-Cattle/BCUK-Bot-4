import { describe, it, expect, vi, beforeEach } from 'vitest';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../../shared/config', () => ({ OVERLAY_STATUS_MAX_SSE_PER_STREAMER: 2, SSE_MAX_TOTAL_CONNECTIONS: 1000 }));
vi.mock('../session', () => ({ getSessionUser: (req: any) => ({ discordId: req.discordId }) }));
const entries = vi.fn();
const conns = vi.hoisted(() => ({ sharedConnections: new Map<string, Set<unknown>>() }));
vi.mock('./sharedOverlaySource', () => ({ getSharedVideoEntries: () => entries(), sharedConnections: conns.sharedConnections }));

import { router, readinessConnections } from './sharedOverlayReadinessStream';
import { recordReadinessReport, resetReadiness, notifyReadinessChange } from './sharedOverlayReadiness';

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
  entries.mockClear();
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

  it('logs, and keeps working, when a later snapshot cannot be built', async () => {
    conns.sharedConnections.set('alice', new Set());
    const { req, res } = fake('m1');
    await handler(req, res);
    entries.mockRejectedValueOnce(new Error('db'));
    recordReadinessReport('alice', { stored: [], downloading: null });
    await vi.waitFor(() => expect(logMock.error).toHaveBeenCalledWith('Failed to publish shared overlay readiness:', expect.any(Error)));
    recordReadinessReport('alice', { stored: [1], downloading: null });
    await vi.waitFor(() => expect(snapshots(res)).toHaveLength(2));
  });

  it('still publishes a report that arrived while a failing lookup was pending', async () => {
    conns.sharedConnections.set('alice', new Set());
    const { req, res } = fake('m1');
    await handler(req, res);
    let failLookup: (err: Error) => void = () => {};
    entries.mockImplementationOnce(() => new Promise((_resolve, reject) => { failLookup = reject; }));
    recordReadinessReport('alice', { stored: [], downloading: null }); // starts the lookup that will fail
    recordReadinessReport('alice', { stored: [1], downloading: null }); // arrives while it is pending
    failLookup(new Error('db'));
    await vi.waitFor(() => expect(snapshots(res)).toHaveLength(2));
    expect(snapshots(res)[1].overlays[0]).toMatchObject({ stored: 1 });
  });

  it('publishes when the enabled list changes, even with no report', async () => {
    const { req, res } = fake('m1');
    await handler(req, res);
    notifyReadinessChange();
    await vi.waitFor(() => expect(snapshots(res)).toHaveLength(2));
  });

  it('looks the first snapshot up again when the list changed during the lookup', async () => {
    let finishFirst: (rows: Array<{ id: number; name: string }>) => void = () => {};
    entries.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const { req, res } = fake('m1');
    const connecting = handler(req, res);
    notifyReadinessChange(); // the list changes while the first lookup is pending: no stream registered yet
    entries.mockResolvedValueOnce([{ id: 1, name: 'Clap' }, { id: 2, name: 'Boo' }]);
    finishFirst([{ id: 1, name: 'Clap' }]); // the stale list
    await connecting;
    expect(snapshots(res)).toHaveLength(1);
    expect(snapshots(res)[0].videos.map((v: { id: number }) => v.id)).toEqual([1, 2]);
  });

  it('stops repeating the first lookup after a few changes, then publishes the fresh state to the new stream', async () => {
    let lookups = 0;
    entries.mockImplementation(async () => {
      lookups++;
      if (lookups <= 3) notifyReadinessChange(); // every one of the first three lookups overlaps a change
      return lookups <= 3 ? [{ id: 1, name: 'Clap' }] : [{ id: 1, name: 'Clap' }, { id: 2, name: 'Boo' }];
    });
    const { req, res } = fake('m1');
    await handler(req, res);
    expect(snapshots(res)[0].videos).toHaveLength(1); // the possibly stale first snapshot
    await vi.waitFor(() => expect(snapshots(res)).toHaveLength(2));
    expect(lookups).toBe(4); // three for the first snapshot (the cap), one refresh after attaching
    expect(snapshots(res)[1].videos.map((v: { id: number }) => v.id)).toEqual([1, 2]);
  });

  it('does not look anything up when no admin stream is open', async () => {
    conns.sharedConnections.set('alice', new Set());
    recordReadinessReport('alice', { stored: [], downloading: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(entries).not.toHaveBeenCalled();
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
