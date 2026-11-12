import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { waitFor } from '../test-utils/waitFor';

// The syncer's script is split over five files that share one global scope on the page.
const source = ['shared-overlay-plan.js', 'shared-overlay-retry.js', 'shared-overlay-source.js', 'shared-overlay-push.js', 'shared-overlay-sync.js']
  .map((name) => fs.readFileSync(path.join(__dirname, '../../public', name), 'utf8'))
  .join('\n');
// Top-level const/function declarations aren't properties of a vm context, so export them explicitly.
const context: Record<string, any> = { setTimeout, clearTimeout, AbortController };
vm.createContext(context);
vm.runInContext(`${source}\nthis.api = { planSharedSync, nextSharedChunkRange, createSharedSyncer, resolveSharedSource, checkedRangeTotal, fetchSharedRange, holdSyncOwnership, buildReadinessReport };`, context);
const { planSharedSync, nextSharedChunkRange, createSharedSyncer, resolveSharedSource, checkedRangeTotal, fetchSharedRange, holdSyncOwnership, buildReadinessReport } = context.api;

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

  it('clears the leftover chunks of a wanted video that is already stored, and keeps the video', () => {
    const plan = planSharedSync([v('/a'), v('/b')], ['/a', '/b'], ['/a']);
    expect(plan.clear).toEqual(['/a']);
    expect(plan.remove).toEqual([]);
    expect(plan.download).toEqual([]);
  });

  it('leaves the chunks of a video that is not stored yet alone', () => {
    expect(planSharedSync([v('/a')], [], ['/a']).clear).toEqual([]);
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

  /** A fake clock whose `sleep` advances it, recording each sleep; for tests where a failed video waits to be retried. */
  const fakeClock = () => {
    const clock = { time: 0, sleeps: [] as number[] };
    return {
      clock,
      timing: { now: () => clock.time, sleep: async (ms: number) => { clock.sleeps.push(ms); clock.time += ms; } },
    };
  };

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

  it('starts a video over when it is removed and added back while a chunk is in flight', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    let first = true;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (first && start === 100) {
        first = false;
        await holder.syncer.sync([]); // the removal's cleanup clears the stored chunks
        await holder.syncer.sync([v('/a')]); // then it is back on the list before the chunk lands
      }
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('does not clear a re-added video\'s new chunks when the removal cleanup finishes late', async () => {
    const storage = memoryStorage();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deleting: () => void = () => {};
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve; });
    const baseDelete = storage.deleteVideo;
    storage.deleteVideo = async (u: string) => { deleting(); await gate; await baseDelete(u); };
    const holder: { syncer?: any } = {};
    let secondChunkCalls = 0;
    let removal: Promise<void> = Promise.resolve();
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100) {
        secondChunkCalls++;
        if (secondChunkCalls === 1) {
          removal = holder.syncer.sync([]); // removal cleanup starts, then stalls in deleteVideo
          await deleteStarted;
          void holder.syncer.sync([v('/a')]); // back on the list while the cleanup is stalled
        } else if (secondChunkCalls === 2) {
          // The restarted download has stored its first chunk; only now does the cleanup go on.
          release();
          await removal; // the cleanup has finished before this chunk is returned
        }
      }
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('clears the chunks of a video that was removed while its download failed', async () => {
    const storage = memoryStorage();
    const holder: { syncer?: any } = {};
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100) {
        void holder.syncer.sync([]);
        throw new Error('network down');
      }
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange, { log: () => {} }));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(storage.chunks.has('/a')).toBe(false);
    expect(storage.videos.has('/a')).toBe(false);
  });

  it('downloads a video again when it is put back while the cleanup after its failed download runs', async () => {
    const storage = memoryStorage();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let clearing: () => void = () => {};
    const clearStarted = new Promise<void>((resolve) => { clearing = resolve; });
    const baseClear = storage.clearChunks;
    let stall = true;
    storage.clearChunks = async (u: string) => {
      if (stall) { stall = false; clearing(); await gate; }
      await baseClear(u);
    };
    const holder: { syncer?: any } = {};
    let failed = false;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100 && !failed) {
        failed = true;
        void holder.syncer.sync([]); // removed, then the fetch fails
        throw new Error('network down');
      }
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange, { log: () => {} }));
    await holder.syncer.sync([v('/a')]);
    await clearStarted;
    await holder.syncer.sync([v('/a')]); // back on the list while the cleanup is stalled
    release();
    await holder.syncer.idle();
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('queues a video again when it is put back while the cleanup after abandoning its download runs', async () => {
    const storage = memoryStorage();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let clearing: () => void = () => {};
    const clearStarted = new Promise<void>((resolve) => { clearing = resolve; });
    const baseClear = storage.clearChunks;
    let stall = true;
    storage.clearChunks = async (u: string) => {
      if (stall) { stall = false; clearing(); await gate; }
      await baseClear(u);
    };
    const holder: { syncer?: any } = {};
    let paused = false;
    let polls = 0;
    const isPaused = () => {
      if (paused && ++polls === 1) void holder.syncer.sync([]); // removed while the download waits to resume
      return paused && polls < 2;
    };
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100) paused = true; // the next chunk waits behind a playing video
      return { buffer: `${url}:${start}`, total: 250 };
    });
    holder.syncer = createSharedSyncer(deps(storage, fetchRange, { isPaused }));
    await holder.syncer.sync([v('/a')]);
    await clearStarted;
    await holder.syncer.sync([v('/a')]); // back on the list while the cleanup is stalled
    release();
    await holder.syncer.idle();
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('clears the leftover chunks of a video that is already stored', async () => {
    const storage = memoryStorage();
    storage.videos.set('/a', ['/a:0', '/a:100', '/a:200']);
    storage.chunks.set('/a', ['/a:0', '/a:100', '/a:200']);
    const fetchRange = fakeFetch(250);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(storage.chunks.has('/a')).toBe(false);
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
    expect(fetchRange).not.toHaveBeenCalled();
  });

  it('logs a failed download and carries on with the next video straight away', async () => {
    const storage = memoryStorage();
    const log = vi.fn();
    const { clock, timing } = fakeClock();
    let failures = 1;
    const fetchRange = vi.fn(async (url: string) => {
      if (url === '/bad' && failures-- > 0) throw new Error('offline');
      return { buffer: 'x', total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, { log, ...timing }));
    await syncer.sync([v('/bad'), v('/good')]);
    await syncer.idle();
    expect(log).toHaveBeenCalledWith('Shared video download failed: /bad', expect.any(Error));
    expect(storage.videos.has('/good')).toBe(true);
    expect(storage.videos.has('/bad')).toBe(true); // retried after its wait
    expect(clock.time).toBe(10000);
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

  describe('fetchNow (Manager push)', () => {
    it('ignores a video that is already stored', async () => {
      const fetchRange = fakeFetch(50);
      const syncer = createSharedSyncer(deps(memoryStorage({ videos: ['/a'] }), fetchRange));
      expect(await syncer.fetchNow(v('/a'))).toBe('ignored');
      expect(fetchRange).not.toHaveBeenCalled();
    });

    it('fetches a missing video, pausing the background queue behind it and resuming afterwards', async () => {
      const storage = memoryStorage();
      const order: string[] = [];
      const holder: { syncer?: any; result?: string } = {};
      const fetchRange = vi.fn(async (url: string, start: number) => {
        order.push(`${url}:${start}`);
        if (url === '/a' && start === 0) holder.result = await holder.syncer.fetchNow(v('/c'));
        return { buffer: `${url}:${start}`, total: 150 };
      });
      holder.syncer = createSharedSyncer(deps(storage, fetchRange));
      await holder.syncer.sync([v('/a'), v('/b')]);
      await holder.syncer.idle();
      expect(holder.result).toBe('fetching');
      // /c jumps in after /a's first chunk, keeps going to the end, then /a resumes (its chunk is kept), then /b.
      expect(order).toEqual(['/a:0', '/c:0', '/c:100', '/a:100', '/b:0', '/b:100']);
      expect([...storage.videos.keys()].sort()).toEqual(['/a', '/b', '/c']);
      expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100']);
    });

    it('finishes a video already downloading in the background at full speed, keeping its chunks', async () => {
      const storage = memoryStorage();
      const sleeps: number[] = [];
      const holder: { syncer?: any; result?: string } = {};
      const fetchRange = vi.fn(async (url: string, start: number) => {
        if (start === 0) holder.result = await holder.syncer.fetchNow(v(url));
        return { buffer: `${url}:${start}`, total: 300 };
      });
      holder.syncer = createSharedSyncer(deps(storage, fetchRange, { chunkPauseMs: 7, sleep: async (ms: number) => { sleeps.push(ms); } }));
      await holder.syncer.sync([v('/a')]);
      await holder.syncer.idle();
      expect(holder.result).toBe('finishing');
      expect(fetchRange).toHaveBeenCalledTimes(3);
      expect(sleeps).not.toContain(7);
      expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
    });

    it('asks for the preload route for background downloads and full speed only for a pushed video', async () => {
      const fullSpeedFlags: Array<[string, boolean]> = [];
      const holder: { syncer?: any } = {};
      const fetchRange = vi.fn(async (url: string, start: number, _end: number, fullSpeed: boolean) => {
        fullSpeedFlags.push([`${url}:${start}`, fullSpeed]);
        if (url === '/a' && start === 0) await holder.syncer.fetchNow(v('/c'));
        return { buffer: 'x', total: 150 };
      });
      holder.syncer = createSharedSyncer(deps(memoryStorage(), fetchRange));
      await holder.syncer.sync([v('/a')]);
      await holder.syncer.idle();
      expect(fullSpeedFlags).toEqual([
        ['/a:0', false], ['/c:0', true], ['/c:100', true], ['/a:100', false],
      ]);
    });

    it('tries a pushed video at once, even while its failed background download waits to be retried', async () => {
      const storage = memoryStorage();
      const { clock, timing } = fakeClock();
      const holder: { syncer?: any; result?: string } = {};
      let failures = 1;
      let fetchedAt = -1;
      const fetchRange = vi.fn(async (url: string, start: number) => {
        if (failures-- > 0) throw new Error('offline');
        fetchedAt = clock.time;
        return { buffer: `${url}:${start}`, total: 50 };
      });
      let pushed = false;
      const sleep = async (ms: number) => {
        await timing.sleep(ms);
        if (!pushed) { pushed = true; holder.result = await holder.syncer.fetchNow(v('/a')); }
      };
      holder.syncer = createSharedSyncer(deps(storage, fetchRange, { now: timing.now, sleep }));
      await holder.syncer.sync([v('/a')]); // fails, and would wait 10 s before its next try
      await holder.syncer.idle();
      expect(holder.result).toBe('fetching');
      expect(fetchedAt).toBe(1000); // right after the first short wait, not after the full 10 s
      expect(storage.videos.has('/a')).toBe(true);
    });

    it('resumes a half-stored video from its chunks', async () => {
      const storage = memoryStorage({ chunks: { '/a': ['/a:0'] } });
      const fetchRange = fakeFetch(200);
      const syncer = createSharedSyncer(deps(storage, fetchRange));
      expect(await syncer.fetchNow(v('/a'))).toBe('fetching');
      await syncer.idle();
      expect(fetchRange.mock.calls.map((c) => c[1])).toEqual([100]);
    });

    it('still waits while a shared video plays', async () => {
      let paused = true;
      let polls = 0;
      const fetchRange = fakeFetch(50);
      const syncer = createSharedSyncer(deps(memoryStorage(), fetchRange, {
        isPaused: () => paused, sleep: async () => { if (++polls === 2) paused = false; },
      }));
      await syncer.fetchNow(v('/a'));
      await Promise.resolve();
      expect(fetchRange).not.toHaveBeenCalled();
      await syncer.idle();
      expect(fetchRange).toHaveBeenCalledTimes(1);
    });
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

  it('does not download a video again when a stale plan queues it after it has finished', async () => {
    const storage = memoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let releasePartial!: () => void;
    const slowPartial = new Promise<string[]>((resolve) => { releasePartial = () => resolve([]); });
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (start === 100) await gate;
      return { buffer: `${url}:${start}`, total: 250 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    await syncer.sync([v('/a')]);
    await waitFor(() => expect(fetchRange).toHaveBeenCalledTimes(2)); // chunk 1 is in flight
    const listPartial = vi.spyOn(storage, 'listPartial').mockReturnValueOnce(slowPartial);
    // This refresh has read the stored list (without /a) but its partial list is still pending.
    const refresh = syncer.sync([v('/a')]);
    await waitFor(() => expect(listPartial).toHaveBeenCalledTimes(1));
    release(); // /a finishes and is stored, so nothing is downloading any more
    await waitFor(() => expect(storage.videos.has('/a')).toBe(true));
    releasePartial(); // the stale plan now queues /a again
    await refresh;
    await syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(3); // not downloaded a second time
    expect(storage.videos.get('/a')).toEqual(['/a:0', '/a:100', '/a:200']);
  });

  it('ignores an older list that a newer one overtook while storage was being read', async () => {
    const storage = memoryStorage({ videos: ['/b'] });
    let releaseRead!: (urls: string[]) => void;
    const slowRead = new Promise<string[]>((resolve) => { releaseRead = resolve; });
    const listVideos = vi.spyOn(storage, 'listVideos').mockReturnValueOnce(slowRead);
    const fetchRange = fakeFetch(50);
    const syncer = createSharedSyncer(deps(storage, fetchRange));
    const older = syncer.sync([v('/a')]); // would delete /b
    await waitFor(() => expect(listVideos).toHaveBeenCalledTimes(1)); // the older list is mid-read
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

  it('retries a failed video after its wait, without a new list', async () => {
    const storage = memoryStorage();
    const { clock, timing } = fakeClock();
    let failures = 1;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (failures-- > 0) throw new Error('offline');
      return { buffer: `${url}:${start}`, total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, timing));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(storage.videos.has('/a')).toBe(true);
    expect(fetchRange).toHaveBeenCalledTimes(2);
    expect(clock.time).toBe(10000);
  });

  it('does not hold up later videos while a failed one waits for its retry', async () => {
    const storage = memoryStorage();
    const { clock, timing } = fakeClock();
    let failures = 1;
    const order: Array<[string, number]> = [];
    const fetchRange = vi.fn(async (url: string, start: number) => {
      order.push([url, clock.time]);
      if (url === '/a' && failures-- > 0) throw new Error('offline');
      return { buffer: `${url}:${start}`, total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, timing));
    await syncer.sync([v('/a'), v('/b')]);
    await syncer.idle();
    // /b is fetched at once (time 0), right after /a failed; /a is retried when its wait is over.
    expect(order).toEqual([['/a', 0], ['/b', 0], ['/a', 10000]]);
    expect([...storage.videos.keys()].sort()).toEqual(['/a', '/b']);
  });

  it('waits twice as long after each failure, up to a cap, and keeps retrying while the video is wanted', async () => {
    const storage = memoryStorage();
    const { clock, timing } = fakeClock();
    let failures = 9;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (failures-- > 0) throw new Error('offline');
      return { buffer: `${url}:${start}`, total: 50 };
    });
    const syncer = createSharedSyncer(deps(storage, fetchRange, timing));
    await syncer.sync([v('/a')]);
    await syncer.idle();
    expect(fetchRange).toHaveBeenCalledTimes(10); // well past eight tries
    expect(storage.videos.has('/a')).toBe(true);
    // 10 s doubling up to the 5 min cap: 10, 20, 40, 80, 160, then 300 s for each later failure.
    expect(clock.time).toBe(10000 + 20000 + 40000 + 80000 + 160000 + 4 * 300000);
  });

  it('starts a video afresh when it is added back after being removed during its retry wait', async () => {
    const storage = memoryStorage();
    const { clock, timing } = fakeClock();
    const holder: { syncer?: any } = {};
    let failures = 1;
    let fetchedAt = -1;
    const fetchRange = vi.fn(async (url: string, start: number) => {
      if (failures-- > 0) throw new Error('offline');
      fetchedAt = clock.time;
      return { buffer: `${url}:${start}`, total: 50 };
    });
    let relisted = false;
    const sleep = async (ms: number) => {
      await timing.sleep(ms);
      if (relisted) return;
      relisted = true;
      await holder.syncer.sync([]); // removed while waiting to retry
      await holder.syncer.sync([v('/a')]); // and added straight back, well before the 10 s wait is over
    };
    holder.syncer = createSharedSyncer(deps(storage, fetchRange, { now: timing.now, sleep }));
    await holder.syncer.sync([v('/a')]);
    await holder.syncer.idle();
    expect(fetchedAt).toBe(1000); // not held back by the earlier failure's wait
    expect(storage.videos.has('/a')).toBe(true);
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

describe('checkedRangeTotal', () => {
  it('returns the total for an answer that covers the requested bytes', () => {
    expect(checkedRangeTotal('bytes 0-99/250', 100, 0, 99)).toBe(250);
  });

  it('accepts a shorter last chunk', () => {
    expect(checkedRangeTotal('bytes 200-249/250', 50, 200, 299)).toBe(250);
  });

  it.each([
    ['a missing header', null, 100],
    ['an unknown total', 'bytes 0-99/*', 100],
    ['a different start', 'bytes 100-199/250', 100],
    ['an answer that stops short before the end of the file', 'bytes 0-49/250', 50],
    ['an answer past the requested end', 'bytes 0-199/250', 200],
    ['an end beyond the file', 'bytes 0-99/50', 100],
    ['a body shorter than the range', 'bytes 0-99/250', 40],
  ])('rejects %s', (_name, header, bytes) => {
    expect(() => checkedRangeTotal(header, bytes as number, 0, 99)).toThrow();
  });
});

describe('fetchSharedRange', () => {
  const answer = (status: number, range: string | null, body: number) => ({
    status,
    headers: { get: () => range },
    arrayBuffer: async () => ({ byteLength: body }),
  });

  it('requests the range and returns the validated bytes and total', async () => {
    const fetchFn = vi.fn(async () => answer(206, 'bytes 0-99/250', 100));
    const part = await fetchSharedRange(fetchFn, '/a', 0, 99, 1000);
    expect(part.total).toBe(250);
    expect(part.buffer.byteLength).toBe(100);
    expect(fetchFn).toHaveBeenCalledWith('/a', expect.objectContaining({ headers: { Range: 'bytes=0-99' } }));
  });

  it('rejects an answer that is not 206', async () => {
    await expect(fetchSharedRange(async () => answer(200, null, 250), '/a', 0, 99, 1000)).rejects.toThrow('answered 200');
  });

  it('rejects a body that is shorter than its range', async () => {
    await expect(fetchSharedRange(async () => answer(206, 'bytes 0-99/250', 40), '/a', 0, 99, 1000)).rejects.toThrow();
  });

  it('gives up when the headers never arrive within the deadline', async () => {
    const stalled = (_url: string, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    await expect(fetchSharedRange(stalled, '/a', 0, 99, 20)).rejects.toThrow('aborted');
  });

  it('gives up when the body stalls after the headers', async () => {
    const stalledBody = (_url: string, options: any) => Promise.resolve({
      status: 206,
      headers: { get: () => 'bytes 0-99/250' },
      arrayBuffer: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('body aborted')));
      }),
    });
    await expect(fetchSharedRange(stalledBody, '/a', 0, 99, 20)).rejects.toThrow('body aborted');
  });
});

describe('holdSyncOwnership', () => {
  it('starts at once without the Web Locks API', () => {
    const start = vi.fn();
    holdSyncOwnership(undefined, 'sync', start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts only once the page holds the lock, and holds it for good', async () => {
    const start = vi.fn();
    let grant: () => Promise<void> = async () => {};
    let held: Promise<void> | undefined;
    const locks = {
      request: vi.fn((_name: string, callback: () => Promise<void>) => new Promise<void>(() => {
        grant = async () => { held = callback(); };
      })),
    };
    holdSyncOwnership(locks, 'sync', start);
    expect(locks.request).toHaveBeenCalledWith('sync', expect.any(Function));
    expect(start).not.toHaveBeenCalled(); // another page holds it
    await grant();
    expect(start).toHaveBeenCalledTimes(1);
    const settled = vi.fn();
    void held!.then(settled);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).not.toHaveBeenCalled(); // the callback never settles, so the lock stays held
  });

  it('starts anyway if the lock request itself fails, and only once', async () => {
    const start = vi.fn();
    holdSyncOwnership({ request: async () => { throw new Error('denied'); } }, 'sync', start);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(start).toHaveBeenCalledTimes(1);
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
    const order = ['sseClient', 'shared-overlay-timing', 'shared-overlay-plan', 'shared-overlay-retry', 'shared-overlay-source', 'shared-overlay-push', 'shared-overlay-sync', 'shared-overlay-storage', 'shared-overlay.js']
      .map((name) => view.indexOf(`/${name}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
