import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { waitFor } from '../test-utils/waitFor';

const source = fs.readFileSync(path.join(__dirname, '../../public/shared-overlay-sync.js'), 'utf8');
// Top-level const/function declarations aren't properties of a vm context, so export them explicitly.
const context: Record<string, any> = {};
vm.createContext(context);
vm.runInContext(`${source}\nthis.api = { planSharedSync, nextSharedChunkRange, createSharedSyncer, resolveSharedSource, buildReadinessReport };`, context);
const { planSharedSync, nextSharedChunkRange, createSharedSyncer, resolveSharedSource, buildReadinessReport } = context.api;

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
function memoryStorage(initial: { videos?: string[]; chunks?: Record<string, string[]>; totals?: Record<string, number> } = {}) {
  const videos = new Map<string, string[]>((initial.videos ?? []).map((u) => [u, []]));
  const chunks = new Map<string, string[]>(Object.entries(initial.chunks ?? {}));
  const totals = new Map<string, number>(Object.entries(initial.totals ?? {}));
  return {
    videos, chunks, totals,
    listVideos: async () => [...videos.keys()],
    listPartial: async () => [...chunks.keys()].filter((u) => (chunks.get(u) ?? []).length > 0),
    countChunks: async (u: string) => (chunks.get(u) ?? []).length,
    getChunks: async (u: string) => chunks.get(u) ?? [],
    chunkTotal: async (u: string) => totals.get(u) ?? null,
    putChunk: async (u: string, i: number, b: string, total?: number) => {
      const a = chunks.get(u) ?? [];
      a[i] = b;
      chunks.set(u, a);
      if (total !== undefined) totals.set(u, total);
    },
    putVideo: async (u: string, c: string[]) => { videos.set(u, c); },
    deleteVideo: async (u: string) => { videos.delete(u); },
    clearChunks: async (u: string) => { chunks.delete(u); totals.delete(u); },
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

  it('finishes chunks that already cover the file without asking for a range past its end', async () => {
    // The page was closed after the last chunk was stored but before the video was joined.
    const storage = memoryStorage({ chunks: { '/a': ['/a:0', '/a:100', '/a:200'] }, totals: { '/a': 250 } });
    const fetchRange = fakeFetch(250);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange).not.toHaveBeenCalled();
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
    expect(storage.chunks.has('/a')).toBe(false);
  });

  it('records the file size with the chunks it stores', async () => {
    const storage = memoryStorage();
    const syncer = createSharedSyncer(deps(storage, fakeFetch(250)));
    const putChunk = vi.spyOn(storage, 'putChunk');
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(putChunk.mock.calls.map((c) => [c[1], c[3]])).toEqual([[0, 250], [1, 250], [2, 250]]);
  });

  it('does not queue the video being downloaded again when the list is refreshed mid-download', async () => {
    const storage = memoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100) await gate;
      return { buffer: `${url}:${start}`, total: 250 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await waitFor(() => expect(fetchRange).toHaveBeenCalledTimes(2)); // chunk 1 is in flight
    await syncer.sync([v('/a')]); // the same list arrives again
    release();
    await syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(3);
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('ignores an older list that a newer one overtook while storage was being read', async () => {
    const storage = memoryStorage({ videos: ['/b'] });
    let releaseRead!: (urls: string[]) => void;
    const slowRead = new Promise<string[]>((resolve) => { releaseRead = resolve; });
    vi.spyOn(storage, 'listVideos').mockReturnValueOnce(slowRead);
    const fetchRange = fakeFetch(50);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    const older = syncer.sync([v('/a')]); // would delete /b
    const newer = syncer.sync([v('/b')]);
    releaseRead(['/b']);
    await Promise.all([older, newer]);
    await syncer.idle();
    expect(storage.videos.has('/b')).toBe(true);
    expect(fetchRange).not.toHaveBeenCalled();
  });

  it('does not keep a video that left the list while its last chunk was in flight', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 200) void holder.syncer.sync([]); // removed while the final range is being fetched
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(3);
    expect(storage.videos.has('/a')).toBe(false);
    expect(storage.chunks.has('/a')).toBe(false);
  });

  it('removes a video again if it left the list while it was being stored', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    const putVideo = storage.putVideo;
    storage.putVideo = async (u: string, c: string[]) => {
      void holder.syncer.sync([]); // removed while the join is being stored
      await putVideo(u, c);
    };
    holder.syncer = createSharedSyncer(deps(storage, fakeFetch(50)));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(storage.videos.has('/a')).toBe(false);
  });

  it('retries a failed video after a wait, without a new list, and keeps going with the others', async () => {
    const storage = memoryStorage();
    const sleeps: number[] = [];
    let failures = 1;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (url === '/a' && failures-- > 0) throw new Error('offline');
      return { buffer: `${url}:${start}`, total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, { sleep: async (ms: number) => { sleeps.push(ms); } }));
    await syncer.sync([v('/a'), v('/b')]);
    await syncer.idle();
    expect(sleeps).toEqual([10000]);
    expect([...storage.videos.keys()].sort()).toEqual(['/a', '/b']);
    // The failed video went to the back of the queue, so /b was stored first.
    expect(fetchRange.mock.calls.map((c) => c[0])).toEqual(['/a', '/b', '/a']);
  });

  it('waits twice as long after each failure, up to a cap, and gives up after eight tries', async () => {
    const storage = memoryStorage();
    const sleeps: number[] = [];
    const fetchRange = vi.fn(async () => { throw new Error('offline'); });
    const syncer = createSharedSyncer(deps(storage, fetchRange, { sleep: async (ms: number) => { sleeps.push(ms); } }));
    await syncer.sync([v('/bad')]);
    await syncer.idle();
    expect(sleeps).toEqual([10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
    expect(fetchRange).toHaveBeenCalledTimes(8);
    // A later list tries it afresh.
    sleeps.length = 0;
    await syncer.sync([v('/bad')]);
    await syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(16);
    expect(sleeps[0]).toBe(10000);
  });

  it('does not retry a failed video that has left the list', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    const fetchRange = vi.fn(async () => { void holder.syncer.sync([]); throw new Error('offline'); });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });

  it('does nothing when everything is already stored', async () => {
    const fetchRange = fakeFetch(50);
    const syncer = createSharedSyncer(deps(memoryStorage({ videos: ['/a'] }), fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange).not.toHaveBeenCalled();
  });
});

describe('resolveSharedSource', () => {
  const blob = { size: 3 };
  const never = () => new Promise<void>(() => {});
  const make = (getVideoBlob: any, extra: object = {}) => {
    const createObjectUrl = vi.fn(() => 'blob:stored');
    const revokeObjectUrl = vi.fn();
    return {
      createObjectUrl, revokeObjectUrl,
      deps: { storage: { getVideoBlob }, createObjectUrl, revokeObjectUrl, sleep: never, ...extra },
    };
  };

  it('plays the stored copy through an object URL and frees it on release', async () => {
    const { deps, createObjectUrl, revokeObjectUrl } = make(vi.fn(async () => blob));
    const source = await resolveSharedSource('/overlay/shared/videos/a.webm', deps);
    expect(source.src).toBe('blob:stored');
    expect(createObjectUrl).toHaveBeenCalledWith(blob);
    source.release();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:stored');
  });

  it('streams from the route when nothing is stored', async () => {
    const { deps, createObjectUrl } = make(vi.fn(async () => null));
    const source = await resolveSharedSource('/overlay/shared/videos/a.webm', deps);
    expect(source.src).toBe('/overlay/shared/videos/a.webm');
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(() => source.release()).not.toThrow();
  });

  it('streams from the route when storage is unavailable', async () => {
    const source = await resolveSharedSource('/v.webm', { storage: null, sleep: never });
    expect(source.src).toBe('/v.webm');
  });

  it('streams from the route when the storage read fails', async () => {
    const { deps } = make(vi.fn(async () => { throw new Error('boom'); }));
    expect((await resolveSharedSource('/v.webm', deps)).src).toBe('/v.webm');
  });

  it('streams from the route when the storage read stalls past the lookup limit', async () => {
    const sleep = vi.fn(async () => {});
    const { deps, createObjectUrl } = make(vi.fn(() => new Promise(() => {})), { sleep });
    const source = await resolveSharedSource('/v.webm', deps);
    expect(source.src).toBe('/v.webm');
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('uses the given lookup limit', async () => {
    const sleep = vi.fn(never);
    const { deps } = make(vi.fn(async () => null), { sleep, lookupMs: 250 });
    await resolveSharedSource('/v.webm', deps);
    expect(sleep).toHaveBeenCalledWith(250);
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
