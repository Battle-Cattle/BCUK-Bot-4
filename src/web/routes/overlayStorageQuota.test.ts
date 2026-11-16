import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// The totals are summed from the DB rows (mocked here), sizing each row's real file on disk.

vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-quota-${process.pid}-${Date.now()}`),
    // 100 bytes per streamer and 200 for the library, so small test files reach the caps.
    OVERLAY_MAX_TOTAL_MB_PER_STREAMER: 100 / (1024 * 1024),
    OVERLAY_LIBRARY_MAX_TOTAL_MB: 200 / (1024 * 1024),
  };
});
vi.mock('../../shared/logger', async () => ({ createLogger: (await import('../../test-utils/loggerMock.js')).mockLogger }));
vi.mock('../../db', () => ({ getVideosForStreamer: vi.fn(), getLibraryVideos: vi.fn() }));

import {
  streamerStoredBytes, libraryStoredBytes, isStreamerStorageFull, exceedsStreamerStorage, exceedsLibraryStorage,
  withStreamerQuota, withLibraryQuota, STREAMER_STORAGE_LIMIT_BYTES, LIBRARY_STORAGE_LIMIT_BYTES,
} from './overlayStorageQuota';
import { getVideosForStreamer, getLibraryVideos } from '../../db';
import { LIBRARY_FOLDER } from './overlayVideoLibraryFiles';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const STREAMER_ID = 7;

/** Writes a file of `bytes` bytes into an OVERLAY_FOLDER subfolder. */
async function writeVideo(folder: string, filename: string, bytes: number) {
  await fs.promises.mkdir(path.join(overlayFolder, folder), { recursive: true });
  await fs.promises.writeFile(path.join(overlayFolder, folder, filename), Buffer.alloc(bytes));
}

/** Makes the streamer's DB rows name these files. */
function streamerRows(...filenames: string[]) {
  vi.mocked(getVideosForStreamer).mockResolvedValue(filenames.map((filename) => ({ filename })) as any);
}

/** Makes the library's DB rows name these files. */
function libraryRows(...filenames: string[]) {
  vi.mocked(getLibraryVideos).mockResolvedValue(filenames.map((filename) => ({ filename })) as any);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
  streamerRows();
  libraryRows();
});

afterAll(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
});

describe('limits', () => {
  it('converts the configured megabytes to bytes', () => {
    expect(STREAMER_STORAGE_LIMIT_BYTES).toBe(100);
    expect(LIBRARY_STORAGE_LIMIT_BYTES).toBe(200);
  });
});

describe('streamerStoredBytes', () => {
  it('sums the files of the streamer\'s rows', async () => {
    await writeVideo('7', 'a.webm', 30);
    await writeVideo('7', 'b.mp4', 45);
    streamerRows('a.webm', 'b.mp4');
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(75);
    expect(getVideosForStreamer).toHaveBeenCalledWith(STREAMER_ID);
  });

  it('is zero for a streamer with no videos or no folder yet', async () => {
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(0);
  });

  it('leaves out files with no row: leftovers, conversion temporary files and other streamers\' videos', async () => {
    await writeVideo('7', 'a.webm', 30);
    await writeVideo('7', 'orphan.webm', 500);
    await writeVideo('7', 'x.webm.part', 500);
    await writeVideo('8', 'theirs.webm', 500);
    streamerRows('a.webm');
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(30);
  });

  it('counts a row whose file is missing, or whose name leaves the folder, as nothing', async () => {
    await writeVideo('7', 'a.webm', 30);
    await writeVideo('8', 'theirs.webm', 500);
    streamerRows('a.webm', 'gone.webm', '../8/theirs.webm');
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(30);
  });

  it('counts a hard-linked import in full', async () => {
    await writeVideo(LIBRARY_FOLDER, 'lib.webm', 60);
    await fs.promises.mkdir(path.join(overlayFolder, '7'), { recursive: true });
    await fs.promises.link(path.join(overlayFolder, LIBRARY_FOLDER, 'lib.webm'), path.join(overlayFolder, '7', 'copy.webm'));
    streamerRows('copy.webm');
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(60);
  });

  it('frees quota once a video\'s row is deleted', async () => {
    await writeVideo('7', 'a.webm', 60);
    await writeVideo('7', 'b.webm', 40);
    streamerRows('a.webm', 'b.webm');
    expect(await isStreamerStorageFull(STREAMER_ID)).toBe(true);
    streamerRows('b.webm');
    expect(await isStreamerStorageFull(STREAMER_ID)).toBe(false);
    expect(await streamerStoredBytes(STREAMER_ID)).toBe(40);
  });
});

describe('streamer cap', () => {
  it('is full at the cap and over it, not under it', async () => {
    await writeVideo('7', 'a.webm', 99);
    streamerRows('a.webm');
    expect(await isStreamerStorageFull(STREAMER_ID)).toBe(false);
    await writeVideo('7', 'a.webm', 100);
    expect(await isStreamerStorageFull(STREAMER_ID)).toBe(true);
    await writeVideo('7', 'a.webm', 101);
    expect(await isStreamerStorageFull(STREAMER_ID)).toBe(true);
  });

  it('lets a new file fill the cap exactly but not pass it', async () => {
    await writeVideo('7', 'a.webm', 60);
    streamerRows('a.webm');
    expect(await exceedsStreamerStorage(STREAMER_ID, 40)).toBe(false);
    expect(await exceedsStreamerStorage(STREAMER_ID, 41)).toBe(true);
  });
});

describe('library cap', () => {
  it('sums the files of the library\'s rows, leaving out files with no row', async () => {
    await writeVideo(LIBRARY_FOLDER, 'one.webm', 80);
    await writeVideo(LIBRARY_FOLDER, 'two.webm', 70);
    await writeVideo(LIBRARY_FOLDER, 'orphan.webm', 500);
    libraryRows('one.webm', 'two.webm');
    expect(await libraryStoredBytes()).toBe(150);
  });

  it('lets a new file fill the cap exactly but not pass it, and frees space when an entry is removed', async () => {
    await writeVideo(LIBRARY_FOLDER, 'one.webm', 80);
    await writeVideo(LIBRARY_FOLDER, 'two.webm', 70);
    libraryRows('one.webm', 'two.webm');
    expect(await exceedsLibraryStorage(50)).toBe(false);
    expect(await exceedsLibraryStorage(51)).toBe(true);
    libraryRows('one.webm');
    expect(await exceedsLibraryStorage(120)).toBe(false);
  });
});

describe('withStreamerQuota / withLibraryQuota', () => {
  /** Runs two operations through `run` and records the order their steps happen in. */
  async function orderOf(run: (key: number, op: () => Promise<void>) => Promise<void>, keys: [number, number]) {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = run(keys[0], async () => {
      events.push('first start');
      await firstHeld;
      events.push('first end');
    });
    const second = run(keys[1], async () => { events.push('second'); });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
    return events;
  }

  it('runs one streamer\'s steps one after another', async () => {
    expect(await orderOf(withStreamerQuota, [7, 7])).toEqual(['first start', 'first end', 'second']);
  });

  it('lets different streamers run at the same time', async () => {
    expect(await orderOf(withStreamerQuota, [7, 8])).toEqual(['first start', 'second', 'first end']);
  });

  it('runs library steps one after another', async () => {
    expect(await orderOf((_key, op) => withLibraryQuota(op), [0, 0])).toEqual(['first start', 'first end', 'second']);
  });

  it('returns the step\'s result and passes its error on, leaving the queue usable', async () => {
    expect(await withStreamerQuota(7, async () => 'done')).toBe('done');
    await expect(withLibraryQuota(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withLibraryQuota(async () => 2)).toBe(2);
  });
});
