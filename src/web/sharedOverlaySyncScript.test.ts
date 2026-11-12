import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/shared-overlay-sync.js'), 'utf8');
// Top-level const/function declarations aren't properties of a vm context, so export them explicitly.
const context: Record<string, any> = {};
vm.createContext(context);
vm.runInContext(`${source}\nthis.api = { planSharedSync, nextSharedChunkRange, createSharedSyncer, buildReadinessReport };`, context);
const { planSharedSync, nextSharedChunkRange, createSharedSyncer, buildReadinessReport } = context.api;

const v = (url: string) => ({ url });

describe('planSharedSync', () => {
  it('queues missing videos in list order (newest first) and skips stored ones', () => {
    const plan = planSharedSync([v('/c'), v('/b'), v('/a')], ['/b'], []);
    expect(plan.download.map((e: any) => e.url)).toEqual(['/c', '/a']);
    expect(plan.remove).toEqual([]);
  });

  it('removes stored and partial videos that left the list, once each', () => {
    const plan = planSharedSync([v('/a')], ['/a', '/old'], ['/old', '/half']);
    expect(plan.remove).toEqual(['/old', '/half']);
    expect(plan.download).toEqual([]);
  });

  it('still downloads a partial video that is on the list', () => {
    expect(planSharedSync([v('/a')], [], ['/a']).download).toHaveLength(1);
  });
});

describe('nextSharedChunkRange', () => {
  it('starts at byte (k + 1) × chunk after chunks 0..k', () => {
    expect(nextSharedChunkRange(0, 100)).toEqual({ start: 0, end: 99 });
    expect(nextSharedChunkRange(3, 100)).toEqual({ start: 300, end: 399 });
  });
});

/** An in-memory storage layer with the syncer's interface. */
function memoryStorage(initial: { videos?: string[]; chunks?: Record<string, string[]> } = {}) {
  const videos = new Map<string, string[]>((initial.videos ?? []).map((u) => [u, []]));
  const chunks = new Map<string, string[]>(Object.entries(initial.chunks ?? {}));
  return {
    videos, chunks,
    listVideos: async () => [...videos.keys()],
    listPartial: async () => [...chunks.keys()].filter((u) => (chunks.get(u) ?? []).length > 0),
    countChunks: async (u: string) => (chunks.get(u) ?? []).length,
    getChunks: async (u: string) => chunks.get(u) ?? [],
    putChunk: async (u: string, i: number, b: string) => { const a = chunks.get(u) ?? []; a[i] = b; chunks.set(u, a); },
    putVideo: async (u: string, c: string[]) => { videos.set(u, c); },
    deleteVideo: async (u: string) => { videos.delete(u); },
    clearChunks: async (u: string) => { chunks.delete(u); },
  };
}

/** A fake server: each chunk's "buffer" is `<url>:<start>`; total is `size`. */
function fakeFetch(size: number) {
  return vi.fn(async (url: string, start: number, _end: number) => ({ buffer: `${url}:${start}`, total: size }));
}

describe('buildReadinessReport', () => {
  const list = [{ id: 1, url: '/a' }, { id: 2, url: '/b' }];

  it('reports the ids of listed, stored videos and the current download by id', () => {
    expect(buildReadinessReport(list, ['/a', '/gone'], { url: '/b', percent: 30 }))
      .toEqual({ stored: [1], downloading: { id: 2, percent: 30 } });
  });

  it('reports no download when none runs or it is no longer listed', () => {
    expect(buildReadinessReport(list, [], null).downloading).toBeNull();
    expect(buildReadinessReport(list, [], { url: '/gone', percent: 5 }).downloading).toBeNull();
  });
});

describe('createSharedSyncer', () => {
  const deps = (storage: any, fetchRange: any, extra: object = {}) => ({
    storage, fetchRange, chunkBytes: 100, chunkPauseMs: 0, isPaused: () => false, sleep: async () => {}, ...extra,
  });

  it('downloads in chunks, joins them in order, stores the video and clears the chunks', async () => {
    const storage = memoryStorage();
    const fetchRange = fakeFetch(250);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange.mock.calls.map((c) => [c[1], c[2]])).toEqual([[0, 99], [100, 199], [200, 299]]);
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
    expect(storage.chunks.has('/a')).toBe(false);
  });

  it('resumes after the stored chunks instead of starting over', async () => {
    const storage = memoryStorage({ chunks: { '/a': ['/a:0', '/a:100'] } });
    const fetchRange = fakeFetch(250);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange.mock.calls.map((c) => c[1])).toEqual([200]);
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('stores newest first, one video at a time', async () => {
    const storage = memoryStorage();
    const order: string[] = [];
    const fetchRange = vi.fn(async (url: string) => { order.push(url); return { buffer: 'x', total: 50 }; });
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/new'), v('/old')]);
    await syncer.idle();
    expect(order).toEqual(['/new', '/old']);
  });

  it('deletes stored and partial videos that left the list', async () => {
    const storage = memoryStorage({ videos: ['/gone', '/keep'], chunks: { '/half': ['x'] } });
    const syncer = createSharedSyncer(deps(storage, fakeFetch(50)));
    await syncer.sync([v('/keep')]);
    await syncer.idle();
    expect([...storage.videos.keys()]).toEqual(['/keep']);
    expect(storage.chunks.has('/half')).toBe(false);
  });

  it('pauses while a shared video plays and resumes afterwards', async () => {
    const storage = memoryStorage();
    const fetchRange = fakeFetch(50);
    let paused = true;
    let polls = 0;
    const sleep = async () => { polls++; if (polls === 3) paused = false; };
    const syncer = createSharedSyncer(deps(storage, fetchRange, { isPaused: () => paused, sleep }));
    await syncer.sync([v('/a')]);
    await Promise.resolve();
    expect(fetchRange).not.toHaveBeenCalled();
    await syncer.idle();
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(fetchRange).toHaveBeenCalledTimes(1);
    expect(storage.videos.has('/a')).toBe(true);
  });

  it('abandons a video removed from the list mid-download', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 0) void holder.syncer.sync([]); // the list changes while the first chunk is in flight
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(1);
    expect(storage.videos.has('/a')).toBe(false);
    expect(storage.chunks.has('/a')).toBe(false);
  });

  it('logs a failed download, waits, and carries on with the next video', async () => {
    const storage = memoryStorage();
    const log = vi.fn();
    const sleeps: number[] = [];
    const fetchRange = vi.fn(async (url: string) => {
      if (url === '/bad') throw new Error('offline');
      return { buffer: 'x', total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, { log, sleep: async (ms: number) => { sleeps.push(ms); } }));
    await syncer.sync([v('/bad'), v('/good')]);
    await syncer.idle();
    expect(log).toHaveBeenCalledWith('Shared video download failed: /bad', expect.any(Error));
    expect(sleeps).toContain(10000);
    expect(storage.videos.has('/good')).toBe(true);
    expect(storage.videos.has('/bad')).toBe(false);
  });

  it('emits progress, stored, removed and idle events for the page to report', async () => {
    const storage = memoryStorage({ videos: ['/gone'] });
    const events: any[] = [];
    const syncer = createSharedSyncer(deps(storage, fakeFetch(150), { onEvent: (e: any) => events.push(e) }));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(events).toEqual([
      { type: 'removed', url: '/gone' },
      { type: 'progress', url: '/a', percent: 67 },
      { type: 'progress', url: '/a', percent: 100 },
      { type: 'stored', url: '/a' },
      { type: 'idle' },
    ]);
  });

  it('does nothing when everything is already stored', async () => {
    const fetchRange = fakeFetch(50);
    const syncer = createSharedSyncer(deps(memoryStorage({ videos: ['/a'] }), fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange).not.toHaveBeenCalled();
  });
});

describe('shared overlay page', () => {
  it('loads the helper scripts before the page script that uses them', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../views/sharedOverlaySource.ejs'), 'utf8');
    const order = ['sseClient', 'shared-overlay-timing', 'shared-overlay-sync', 'shared-overlay-storage', 'shared-overlay.js']
      .map((name) => view.indexOf(`/${name}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
