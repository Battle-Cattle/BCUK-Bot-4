import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => mockLog }));

// A real overlay folder, unique to this test run.
vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-orphan-sweep-${process.pid}-${Date.now()}`),
    OVERLAY_TRANSCODE_TIMEOUT_MINUTES: 30,
  };
});

vi.mock('../../db', () => ({
  getRecordedVideoFilenames: vi.fn(),
  getRecordedLibraryFilenames: vi.fn(),
  getRecordedSharedVideoFilenames: vi.fn(),
}));

import { getRecordedLibraryFilenames, getRecordedSharedVideoFilenames, getRecordedVideoFilenames } from '../../db';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';
import { withInFlightVideoFile } from './overlayInFlightFiles';
import { linkVideoFile } from './overlayVideoLibraryFiles';
import {
  ORPHAN_MIN_AGE_MS, sweepOrphanedOverlayVideos, startOverlayOrphanSweep, stopOverlayOrphanSweep, __resetOverlayOrphanSweepForTests,
} from './overlayOrphanSweep';
import { STALE_TEMP_FILE_MS } from './overlayFiles';
import { waitFor } from '../../test-utils/waitFor';

/** A `now` far enough ahead that every file written by the test counts as old. ctime can't be backdated. */
const later = () => Date.now() + ORPHAN_MIN_AGE_MS + 60_000;

/** Writes a file under OVERLAY_FOLDER. */
function write(folder: string, filename: string): void {
  fs.mkdirSync(path.join(overlayFolder, folder), { recursive: true });
  fs.writeFileSync(path.join(overlayFolder, folder, filename), 'video bytes');
}

/** Whether a file exists under OVERLAY_FOLDER (a dangling symlink counts). */
function exists(folder: string, filename: string): boolean {
  try {
    fs.lstatSync(path.join(overlayFolder, folder, filename));
    return true;
  } catch {
    return false;
  }
}

/** Makes the DB report rows for these streamer files, library files and shared files. */
function recordRows(streamerRows: Record<number, string[]>, libraryRows: string[] = [], sharedRows: string[] = []): void {
  vi.mocked(getRecordedVideoFilenames).mockImplementation(async (streamerId, filenames) =>
    new Set(filenames.filter((f) => (streamerRows[streamerId] ?? []).includes(f))));
  vi.mocked(getRecordedLibraryFilenames).mockImplementation(async (filenames) =>
    new Set(filenames.filter((f) => libraryRows.includes(f))));
  vi.mocked(getRecordedSharedVideoFilenames).mockImplementation(async (filenames) =>
    new Set(filenames.filter((f) => sharedRows.includes(f))));
}

let outside: string;

beforeEach(() => {
  vi.clearAllMocks();
  __resetOverlayOrphanSweepForTests();
  fs.rmSync(overlayFolder, { recursive: true, force: true });
  fs.mkdirSync(overlayFolder, { recursive: true });
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-orphan-outside-'));
  recordRows({});
});

afterEach(() => {
  __resetOverlayOrphanSweepForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(outside, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(overlayFolder, { recursive: true, force: true });
});

describe('sweepOrphanedOverlayVideos', () => {
  it('waits at least as long as a temporary upload or conversion file may live', () => {
    expect(ORPHAN_MIN_AGE_MS).toBeGreaterThanOrEqual(STALE_TEMP_FILE_MS);
  });

  it('removes an old file with no row and keeps one with a row, or a new one without', async () => {
    write('5', 'orphan.webm');
    write('5', 'kept.mp4');
    recordRows({ 5: ['kept.mp4'] });

    await expect(sweepOrphanedOverlayVideos(Date.now())).resolves.toBe(0);
    expect(exists('5', 'orphan.webm')).toBe(true);
    expect(getRecordedVideoFilenames).not.toHaveBeenCalled();

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(1);
    expect(exists('5', 'orphan.webm')).toBe(false);
    expect(exists('5', 'kept.mp4')).toBe(true);
  });

  it('checks the library against library entries and streamer folders against that streamer\'s videos', async () => {
    write('library', 'lib-kept.webm');
    write('library', 'lib-orphan.webm');
    write('5', 'shared-name.webm');
    write('6', 'shared-name.webm');
    recordRows({ 5: ['shared-name.webm'] }, ['lib-kept.webm']);

    await sweepOrphanedOverlayVideos(later());

    expect(exists('library', 'lib-kept.webm')).toBe(true);
    expect(exists('library', 'lib-orphan.webm')).toBe(false);
    expect(exists('5', 'shared-name.webm')).toBe(true);
    expect(exists('6', 'shared-name.webm')).toBe(false);
    expect(getRecordedVideoFilenames).toHaveBeenCalledWith(5, ['shared-name.webm']);
    expect(getRecordedVideoFilenames).toHaveBeenCalledWith(6, ['shared-name.webm']);
    expect(getRecordedLibraryFilenames).toHaveBeenCalledWith(expect.arrayContaining(['lib-kept.webm', 'lib-orphan.webm']));
  });

  it('never touches .incoming, MOV conversion files, other names, odd folders or symlinks', async () => {
    write('.incoming', 'x.webm');
    write('007', 'x.webm');
    write('notes', 'x.webm');
    write('5', 'a1b2.mov.upload');
    write('5', 'a1b2.webm.part');
    write('5', 'readme.txt');
    fs.writeFileSync(path.join(outside, 'target.webm'), 'outside');
    fs.symlinkSync(path.join(outside, 'target.webm'), path.join(overlayFolder, '5', 'link.webm'));
    fs.writeFileSync(path.join(outside, 'x.webm'), 'outside');
    fs.symlinkSync(outside, path.join(overlayFolder, '9'));

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);

    for (const [folder, filename] of [
      ['.incoming', 'x.webm'], ['007', 'x.webm'], ['notes', 'x.webm'],
      ['5', 'a1b2.mov.upload'], ['5', 'a1b2.webm.part'], ['5', 'readme.txt'], ['5', 'link.webm'],
    ] as const) {
      expect(exists(folder, filename), `${folder}/${filename}`).toBe(true);
    }
    expect(fs.existsSync(path.join(outside, 'target.webm'))).toBe(true);
    expect(fs.existsSync(path.join(outside, 'x.webm'))).toBe(true);
    expect(getRecordedVideoFilenames).not.toHaveBeenCalled();
  });

  it('removes nothing when the DB is unavailable', async () => {
    write('5', 'orphan.webm');
    write('library', 'lib-orphan.webm');
    vi.mocked(getRecordedVideoFilenames).mockRejectedValue(new Error('db down'));
    vi.mocked(getRecordedLibraryFilenames).mockRejectedValue(new Error('db down'));

    await expect(sweepOrphanedOverlayVideos(later())).rejects.toThrow('db down');
    expect(exists('5', 'orphan.webm')).toBe(true);
    expect(exists('library', 'lib-orphan.webm')).toBe(true);
  });

  it('skips a file removed between listing and checking its age, and sweeps the rest', async () => {
    write('5', 'gone.webm');
    write('5', 'orphan.webm');
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p, ...rest) => {
      if (String(p).endsWith('gone.webm')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return lstat(p, ...rest);
    });

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(1);
    expect(getRecordedVideoFilenames).toHaveBeenCalledWith(5, ['orphan.webm']);
  });

  it('removes nothing from a folder whose files it can\'t check', async () => {
    write('5', 'orphan.webm');
    vi.spyOn(fs.promises, 'lstat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

    await expect(sweepOrphanedOverlayVideos(later())).rejects.toThrow('denied');
    vi.mocked(fs.promises.lstat).mockRestore();
    expect(exists('5', 'orphan.webm')).toBe(true);
  });

  it('fails the run when the overlay folder can\'t be listed', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(sweepOrphanedOverlayVideos(later())).rejects.toThrow('denied');
  });

  it('removes nothing from any folder when a later folder\'s check fails', async () => {
    for (const folder of ['5', '6', '7', 'library']) write(folder, 'orphan.webm');
    // Only streamer 6's lookup fails; every other folder checks out with no rows.
    vi.mocked(getRecordedVideoFilenames).mockImplementation(async (streamerId) => {
      if (streamerId === 6) throw new Error('db down');
      return new Set();
    });
    vi.mocked(getRecordedLibraryFilenames).mockResolvedValue(new Set());

    await expect(sweepOrphanedOverlayVideos(later())).rejects.toThrow('db down');
    for (const folder of ['5', '6', '7', 'library']) expect(exists(folder, 'orphan.webm'), folder).toBe(true);
  });

  it('does nothing when the overlay folder doesn\'t exist yet', async () => {
    fs.rmSync(overlayFolder, { recursive: true, force: true });
    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);
  });

  it('looks filenames up in bounded batches', async () => {
    for (let i = 0; i < 501; i++) write('5', `f${i}.webm`);
    recordRows({ 5: ['f0.webm'] });

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(500);
    expect(vi.mocked(getRecordedVideoFilenames).mock.calls.map(([, names]) => names.length).sort()).toEqual([1, 500]);
    expect(exists('5', 'f0.webm')).toBe(true);
  });

  it('never removes a file whose write is still in flight, however old', async () => {
    write('5', 'stalled.webm');
    let finish!: () => void;
    const stalled = withInFlightVideoFile({ folder: '5', filename: 'stalled.webm' }, () => new Promise<void>((resolve) => { finish = resolve; }));

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);
    expect(exists('5', 'stalled.webm')).toBe(true);
    expect(getRecordedVideoFilenames).not.toHaveBeenCalled();

    finish();
    await stalled;
  });

  it('keeps a file whose write commits its row between the registry check and the DB query', async () => {
    write('5', 'orphan.webm');
    write('5', 'committing.webm');
    let commit!: () => void;
    const committing = withInFlightVideoFile({ folder: '5', filename: 'committing.webm' }, () => new Promise<void>((resolve) => { commit = resolve; }));
    vi.mocked(getRecordedVideoFilenames).mockImplementation(async (_streamerId, filenames) => {
      // The write commits its row and leaves the registry while the sweep queries the DB.
      commit();
      await committing;
      return new Set(filenames.filter((f) => f === 'committing.webm'));
    });

    await sweepOrphanedOverlayVideos(later());

    expect(getRecordedVideoFilenames).toHaveBeenCalledWith(5, ['orphan.webm']);
    expect(exists('5', 'committing.webm')).toBe(true);
    expect(exists('5', 'orphan.webm')).toBe(false);
  });

  it('keeps an imported copy with its row after its library entry and library file are gone', async () => {
    write('library', 'lib.webm');
    const imported = (await linkVideoFile({ folder: 'library', filename: 'lib.webm' }, '5'))!;
    fs.rmSync(path.join(overlayFolder, 'library', 'lib.webm'));
    recordRows({ 5: [imported] });

    await sweepOrphanedOverlayVideos(later());

    expect(exists('5', imported)).toBe(true);
  });

  it('removes a copy linked into a streamer folder with no row (an interrupted import) once it is old enough', async () => {
    write('library', 'lib.webm');
    const imported = (await linkVideoFile({ folder: 'library', filename: 'lib.webm' }, '5'))!;
    recordRows({}, ['lib.webm']);

    await sweepOrphanedOverlayVideos(Date.now());
    expect(exists('5', imported)).toBe(true);

    await sweepOrphanedOverlayVideos(later());
    expect(exists('5', imported)).toBe(false);
    expect(exists('library', 'lib.webm')).toBe(true);
  });
});

describe('sweepOrphanedOverlayVideos in the shared folder', () => {
  it('removes an old shared file with no row and keeps one with a row, or a new one without', async () => {
    write('shared', 'orphan.webm');
    write('shared', 'kept.webm');
    recordRows({}, [], ['kept.webm']);

    await expect(sweepOrphanedOverlayVideos(Date.now())).resolves.toBe(0);
    expect(exists('shared', 'orphan.webm')).toBe(true);
    expect(getRecordedSharedVideoFilenames).not.toHaveBeenCalled();

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(1);
    expect(exists('shared', 'orphan.webm')).toBe(false);
    expect(exists('shared', 'kept.webm')).toBe(true);
    expect(getRecordedSharedVideoFilenames).toHaveBeenCalledWith(expect.arrayContaining(['orphan.webm', 'kept.webm']));
  });

  it('checks the shared folder against shared videos only, not a streamer\'s or the library\'s rows', async () => {
    write('shared', 'same.webm');
    recordRows({ 5: ['same.webm'] }, ['same.webm']);

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(1);
    expect(exists('shared', 'same.webm')).toBe(false);
    expect(getRecordedVideoFilenames).not.toHaveBeenCalled();
    expect(getRecordedLibraryFilenames).not.toHaveBeenCalled();
  });

  it('only considers WebM names there, leaving conversion files, MP4s, other names and symlinks alone', async () => {
    write('shared', 'a1b2.mov.upload');
    write('shared', 'a1b2.webm.part');
    write('shared', 'clip.mp4');
    write('shared', 'readme.txt');
    fs.writeFileSync(path.join(outside, 'target.webm'), 'outside');
    fs.symlinkSync(path.join(outside, 'target.webm'), path.join(overlayFolder, 'shared', 'link.webm'));

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);

    for (const filename of ['a1b2.mov.upload', 'a1b2.webm.part', 'clip.mp4', 'readme.txt', 'link.webm']) {
      expect(exists('shared', filename), filename).toBe(true);
    }
    expect(fs.existsSync(path.join(outside, 'target.webm'))).toBe(true);
    expect(getRecordedSharedVideoFilenames).not.toHaveBeenCalled();
  });

  it('leaves a symlinked shared folder alone', async () => {
    fs.writeFileSync(path.join(outside, 'x.webm'), 'outside');
    fs.symlinkSync(outside, path.join(overlayFolder, 'shared'));

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);
    expect(fs.existsSync(path.join(outside, 'x.webm'))).toBe(true);
  });

  it('never removes a shared file whose write is still in flight, however old', async () => {
    write('shared', 'stalled.webm');
    let finish!: () => void;
    const writing = withInFlightVideoFile({ folder: 'shared', filename: 'stalled.webm' }, () => new Promise<void>((resolve) => { finish = resolve; }));

    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(0);
    expect(exists('shared', 'stalled.webm')).toBe(true);
    expect(getRecordedSharedVideoFilenames).not.toHaveBeenCalled();

    finish();
    await writing;
    await expect(sweepOrphanedOverlayVideos(later())).resolves.toBe(1);
    expect(exists('shared', 'stalled.webm')).toBe(false);
  });

  it('removes nothing anywhere when the shared folder can\'t be checked against the DB', async () => {
    write('shared', 'orphan.webm');
    write('5', 'orphan.webm');
    vi.mocked(getRecordedSharedVideoFilenames).mockRejectedValue(new Error('db down'));

    await expect(sweepOrphanedOverlayVideos(later())).rejects.toThrow('db down');
    expect(exists('shared', 'orphan.webm')).toBe(true);
    expect(exists('5', 'orphan.webm')).toBe(true);
  });
});

describe('startOverlayOrphanSweep', () => {
  it('sweeps at start and then daily, logging the count, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    startOverlayOrphanSweep();
    startOverlayOrphanSweep(); // a second start is a no-op
    await waitFor(() => expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('removed 0 file(s)')));
    expect(mockLog.info).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await waitFor(() => expect(mockLog.info).toHaveBeenCalledTimes(2));

    stopOverlayOrphanSweep();
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60_000);
    expect(mockLog.info).toHaveBeenCalledTimes(2);
  });

  it('logs a failed run instead of rejecting, and skips a tick while a run is still going', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // A file old enough to need a DB lookup, so the run waits on the stalled query.
    write('5', 'orphan.webm');
    let fail!: (err: Error) => void;
    vi.mocked(getRecordedVideoFilenames).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ORPHAN_MIN_AGE_MS + 60_000);

    startOverlayOrphanSweep();
    await waitFor(() => expect(getRecordedVideoFilenames).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(getRecordedVideoFilenames).toHaveBeenCalledOnce();

    fail(new Error('db down'));
    await waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('stopped without finishing'), expect.any(Error)));
    expect(exists('5', 'orphan.webm')).toBe(true);
  });
});
