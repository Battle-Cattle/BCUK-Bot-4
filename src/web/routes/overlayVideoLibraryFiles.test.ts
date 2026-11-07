import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mockLogger } from '../../test-utils/loggerMock';

// A real overlay folder, unique to this test run: this is about how the filesystem links files.
vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return { OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-library-${process.pid}-${Date.now()}`) };
});
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import {
  LIBRARY_FOLDER, streamerFolder, linkVideoFile, removeVideoFile, removeLibraryVideoFile, withLinkedVideoFile,
} from './overlayVideoLibraryFiles';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const UUID_WEBM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/;

/** Writes a video file into an OVERLAY_FOLDER subfolder and returns its location. */
async function writeVideo(folder: string, filename: string, contents = 'video bytes') {
  await fs.promises.mkdir(path.join(overlayFolder, folder), { recursive: true });
  await fs.promises.writeFile(path.join(overlayFolder, folder, filename), contents);
  return { folder, filename };
}

/** Reads a file in an OVERLAY_FOLDER subfolder as text. */
function readVideo(folder: string, filename: string) {
  return fs.promises.readFile(path.join(overlayFolder, folder, filename), 'utf8');
}

/** Whether a file exists in an OVERLAY_FOLDER subfolder. */
function exists(folder: string, filename: string) {
  return fs.existsSync(path.join(overlayFolder, folder, filename));
}

beforeEach(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
});

describe('streamerFolder', () => {
  it('names the folder by the numeric streamer id, which can never be the library folder', () => {
    expect(streamerFolder(42)).toBe('42');
    expect(LIBRARY_FOLDER).toBe('library');
    expect(LIBRARY_FOLDER).not.toMatch(/^\d+$/);
  });
});

describe('linkVideoFile', () => {
  it('hard-links into a new UUID filename keeping the extension, creating the folder', async () => {
    const source = await writeVideo('5', 'clip.webm');
    const copy = vi.spyOn(fs.promises, 'copyFile');

    const filename = await linkVideoFile(source, LIBRARY_FOLDER);

    expect(filename).toMatch(UUID_WEBM);
    expect(await readVideo(LIBRARY_FOLDER, filename!)).toBe('video bytes');
    expect(copy).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([
      fs.promises.stat(path.join(overlayFolder, '5', 'clip.webm')),
      fs.promises.stat(path.join(overlayFolder, LIBRARY_FOLDER, filename!)),
    ]);
    expect(b.ino).toBe(a.ino);
  });

  it('leaves the other side readable when either link is removed', async () => {
    const source = await writeVideo('5', 'clip.webm');
    const inLibrary = (await linkVideoFile(source, LIBRARY_FOLDER))!;
    const imported = (await linkVideoFile({ folder: LIBRARY_FOLDER, filename: inLibrary }, streamerFolder(9)))!;

    await removeVideoFile(source);
    expect(await readVideo(LIBRARY_FOLDER, inLibrary)).toBe('video bytes');

    await removeLibraryVideoFile(inLibrary);
    expect(exists(LIBRARY_FOLDER, inLibrary)).toBe(false);
    expect(await readVideo('9', imported)).toBe('video bytes');
  });

  it('falls back to a copy when the hard link fails with EXDEV', async () => {
    const source = await writeVideo('5', 'clip.webm');
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    const copy = vi.spyOn(fs.promises, 'copyFile');

    const filename = await linkVideoFile(source, streamerFolder(9));

    expect(copy).toHaveBeenCalledTimes(1);
    expect(await readVideo('9', filename!)).toBe('video bytes');
    await removeVideoFile(source);
    expect(await readVideo('9', filename!)).toBe('video bytes');
  });

  it('falls back to a copy when the hard link fails with EPERM', async () => {
    const source = await writeVideo('5', 'clip.webm');
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('not permitted'), { code: 'EPERM' }));

    const filename = await linkVideoFile(source, LIBRARY_FOLDER);

    expect(await readVideo(LIBRARY_FOLDER, filename!)).toBe('video bytes');
  });

  it('throws when both the link and the copy fail', async () => {
    const source = await writeVideo('5', 'clip.webm');
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));

    await expect(linkVideoFile(source, LIBRARY_FOLDER)).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('returns null for a missing source', async () => {
    await expect(linkVideoFile({ folder: '5', filename: 'missing.webm' }, LIBRARY_FOLDER)).resolves.toBeNull();
  });

  it.each([
    ['a traversing filename', { folder: '5', filename: '../6/clip.webm' }, LIBRARY_FOLDER],
    ['a traversing folder', { folder: '..', filename: 'clip.webm' }, LIBRARY_FOLDER],
    ['a non-video source folder', { folder: '.incoming', filename: 'clip.webm' }, LIBRARY_FOLDER],
    ['a non-video destination folder', { folder: '5', filename: 'clip.webm' }, '../elsewhere'],
  ])('refuses %s', async (_label, source, destFolder) => {
    await writeVideo('5', 'clip.webm');
    await writeVideo('6', 'clip.webm');
    await writeVideo('.incoming', 'clip.webm');

    await expect(linkVideoFile(source, destFolder)).resolves.toBeNull();
    expect(fs.existsSync(path.join(overlayFolder, LIBRARY_FOLDER))).toBe(false);
  });

  it('refuses a source reached through a link that escapes OVERLAY_FOLDER', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overlay-library-outside-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'secret.webm'), 'secret');
      await fs.promises.mkdir(overlayFolder, { recursive: true });
      // A directory link ('junction' is allowed on Windows without elevated privileges).
      await fs.promises.symlink(outside, path.join(overlayFolder, '7'), 'junction');

      await expect(linkVideoFile({ folder: '7', filename: 'secret.webm' }, LIBRARY_FOLDER)).resolves.toBeNull();
      expect(fs.existsSync(path.join(overlayFolder, LIBRARY_FOLDER))).toBe(false);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('removeVideoFile', () => {
  it('ignores a missing file and a traversing path', async () => {
    await writeVideo('5', 'clip.webm');
    await expect(removeVideoFile({ folder: '5', filename: 'missing.webm' })).resolves.toBeUndefined();
    await expect(removeVideoFile({ folder: '5', filename: '../5/clip.webm' })).resolves.toBeUndefined();
    expect(exists('5', 'clip.webm')).toBe(true);
  });

  it('logs instead of throwing when removal fails', async () => {
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await expect(removeVideoFile({ folder: '5', filename: 'clip.webm' })).resolves.toBeUndefined();
  });
});

describe('withLinkedVideoFile', () => {
  it('keeps the new file and returns the DB result when the DB step succeeds', async () => {
    const source = await writeVideo('5', 'clip.webm');
    const dbStep = vi.fn().mockResolvedValue(31);

    const outcome = await withLinkedVideoFile(source, LIBRARY_FOLDER, dbStep);

    expect(outcome).toEqual({ status: 'linked', filename: expect.stringMatching(UUID_WEBM), result: 31 });
    if (outcome.status !== 'linked') throw new Error('expected linked');
    expect(dbStep).toHaveBeenCalledWith(outcome.filename);
    expect(exists(LIBRARY_FOLDER, outcome.filename)).toBe(true);
  });

  it('removes the new file and rethrows when the DB step throws', async () => {
    const source = await writeVideo('5', 'clip.webm');
    let created = '';
    const dbStep = vi.fn(async (filename: string) => {
      created = filename;
      throw new Error('db down');
    });

    await expect(withLinkedVideoFile(source, LIBRARY_FOLDER, dbStep)).rejects.toThrow('db down');
    expect(created).toMatch(UUID_WEBM);
    expect(exists(LIBRARY_FOLDER, created)).toBe(false);
    expect(exists('5', 'clip.webm')).toBe(true);
  });

  it('removes the new file when keep() says the row was not written', async () => {
    const source = await writeVideo('5', 'clip.webm');

    const outcome = await withLinkedVideoFile(source, LIBRARY_FOLDER, async () => ({ status: 'already_in_library' }), (r) => r.status === 'added');

    if (outcome.status !== 'linked') throw new Error('expected linked');
    expect(outcome.result).toEqual({ status: 'already_in_library' });
    expect(exists(LIBRARY_FOLDER, outcome.filename)).toBe(false);
  });

  it('returns source_missing without running the DB step when the source is missing', async () => {
    const dbStep = vi.fn();

    await expect(withLinkedVideoFile({ folder: '5', filename: 'missing.webm' }, LIBRARY_FOLDER, dbStep))
      .resolves.toEqual({ status: 'source_missing' });
    expect(dbStep).not.toHaveBeenCalled();
  });
});
