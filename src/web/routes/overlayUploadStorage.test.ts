import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { mockLogger } from '../../test-utils/loggerMock';

// A real folder for the uploads, unique to this test run; the storage creates it on first use.
vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return { OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-upload-${process.pid}-${Date.now()}`) };
});
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import {
  INCOMING_DIR, adoptChunkedUpload, detectUploadedVideoType, placeUpload, discardUpload, sweepStaleIncomingUploads,
} from './overlayUploadStorage';
import type { UploadedFile } from '../uploadedFile';
import { STALE_TEMP_FILE_MS } from './overlayFiles';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const MOV_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x14, ...Buffer.from('ftypqt  ', 'ascii'), ...Buffer.alloc(64, 7)]);

let adoptedCount = 0;

/** Writes `bytes` as a finished chunked upload and adopts it, like the complete route does. */
async function adopted(bytes: Buffer): Promise<UploadedFile> {
  const sessionDir = path.join(INCOMING_DIR, 'chunked');
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const assembled = path.join(sessionDir, `upload-${adoptedCount++}.done`);
  await fs.promises.writeFile(assembled, bytes);
  return adoptChunkedUpload({ path: assembled, name: 'clip.mov', size: bytes.length, type: 'video/quicktime' }, 'video');
}

/** Files currently in the incoming folder (not counting the chunked-session folder), sorted. */
async function incoming() {
  return (await fs.promises.readdir(INCOMING_DIR).catch(() => [] as string[])).filter((n) => n !== 'chunked').sort();
}
beforeEach(async () => {
  await fs.promises.rm(INCOMING_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
});

describe('detectUploadedVideoType', () => {
  it('detects the type from the file on disk', async () => {
    const file = await adopted(MOV_BYTES);
    expect(await detectUploadedVideoType(file)).toBe('mov');
  });

  it('returns null for a file that is not a video', async () => {
    const file = await adopted(Buffer.from('hello'));
    expect(await detectUploadedVideoType(file)).toBeNull();
  });
});

describe('placeUpload', () => {
  /** Stores MOV_BYTES as an upload and returns its file record and a destination path. */
  async function stored() {
    const file = await adopted(MOV_BYTES);
    const dest = path.join(overlayFolder, `dest-${Date.now()}-${Math.random()}.mov.upload`);
    return { file, dest };
  }

  it('moves the upload to its destination', async () => {
    const { file, dest } = await stored();
    await placeUpload(file, dest);
    expect(await fs.promises.readFile(dest)).toEqual(MOV_BYTES);
    expect(await incoming()).toEqual([]);
  });

  it('copies and removes the upload when the destination is on another disk', async () => {
    const { file, dest } = await stored();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    await placeUpload(file, dest);
    expect(await fs.promises.readFile(dest)).toEqual(MOV_BYTES);
    expect(await incoming()).toEqual([]);
  });

  it('removes a partial copy and rethrows when copying across disks fails', async () => {
    const { file, dest } = await stored();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async () => {
      await fs.promises.writeFile(dest, 'half');
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    });
    await expect(placeUpload(file, dest)).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(fs.promises.access(dest)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rethrows any other rename failure without copying', async () => {
    const { file, dest } = await stored();
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const copy = vi.spyOn(fs.promises, 'copyFile');
    await expect(placeUpload(file, dest)).rejects.toMatchObject({ code: 'EACCES' });
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('discardUpload', () => {
  it('removes the upload, and does nothing if it has already gone', async () => {
    const file = await adopted(MOV_BYTES);
    await discardUpload(file);
    expect(await incoming()).toEqual([]);
    await expect(discardUpload(file)).resolves.toBeUndefined();
  });

  it('logs instead of throwing when the upload cannot be removed, and can still remove it later', async () => {
    const file = await adopted(MOV_BYTES);
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('denied'));
    await expect(discardUpload(file)).resolves.toBeUndefined();
    expect(await incoming()).toHaveLength(1);
    await discardUpload(file);
    expect(await incoming()).toEqual([]);
  });

  it('does nothing once the upload has been moved into place', async () => {
    const file = await adopted(MOV_BYTES);
    const dest = path.join(overlayFolder, `placed-${Date.now()}.webm`);
    await placeUpload(file, dest);
    const rm = vi.spyOn(fs.promises, 'rm');
    await discardUpload(file);
    expect(rm).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(dest)).toEqual(MOV_BYTES);
  });
});

describe('uploads this process did not store', () => {
  const outside = { path: '/etc/passwd', filename: '../../etc/passwd', originalname: 'clip.mov' } as UploadedFile;

  it('are refused rather than read, moved or removed, whatever path their record names', async () => {
    const rm = vi.spyOn(fs.promises, 'rm');
    const rename = vi.spyOn(fs.promises, 'rename');
    await expect(detectUploadedVideoType(outside)).rejects.toThrow('Unknown overlay upload');
    await expect(placeUpload(outside, path.join(overlayFolder, 'dest'))).rejects.toThrow('Unknown overlay upload');
    await expect(discardUpload(outside)).resolves.toBeUndefined();
    expect(rm).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('sweepStaleIncomingUploads', () => {
  /** Writes `name` into the incoming folder, last modified `ageMs` ago. */
  async function writeAged(name: string, ageMs: number) {
    await fs.promises.mkdir(INCOMING_DIR, { recursive: true });
    const fullPath = path.join(INCOMING_DIR, name);
    await fs.promises.writeFile(fullPath, 'x');
    const time = new Date(Date.now() - ageMs);
    await fs.promises.utimes(fullPath, time, time);
  }

  it('removes only .incoming files too old to belong to an upload still arriving', async () => {
    await writeAged('old.incoming', STALE_TEMP_FILE_MS + 60_000);
    await writeAged('new.incoming', 60_000);
    await writeAged('other.txt', STALE_TEMP_FILE_MS * 10);
    await sweepStaleIncomingUploads();
    expect(await incoming()).toEqual(['new.incoming', 'other.txt']);
  });

  it('does nothing when the incoming folder does not exist yet', async () => {
    await expect(sweepStaleIncomingUploads()).resolves.toBeUndefined();
  });
});

describe('adoptChunkedUpload', () => {
  it('moves an assembled chunked upload into the incoming folder as an upload this process can use', async () => {
    const sessionDir = path.join(INCOMING_DIR, 'chunked');
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const assembled = path.join(sessionDir, 'abc.done');
    await fs.promises.writeFile(assembled, MOV_BYTES);
    const file = await adoptChunkedUpload({ path: assembled, name: 'clip.mov', size: MOV_BYTES.length, type: 'video/quicktime' }, 'video');
    expect(file).toMatchObject({ fieldname: 'video', originalname: 'clip.mov', mimetype: 'video/quicktime', size: MOV_BYTES.length });
    expect(file.filename).toMatch(/\.incoming$/);
    expect(fs.existsSync(assembled)).toBe(false);
    expect(await detectUploadedVideoType(file)).toBe('mov');
    await discardUpload(file);
    expect(fs.existsSync(file.path)).toBe(false);
  });
});

describe('adoptChunkedUpload failures', () => {
  it('removes the assembled file and rethrows when it cannot be moved into the incoming folder', async () => {
    const sessionDir = path.join(INCOMING_DIR, 'chunked');
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const assembled = path.join(sessionDir, 'failed.done');
    await fs.promises.writeFile(assembled, MOV_BYTES);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(adoptChunkedUpload({ path: assembled, name: 'clip.mov', size: MOV_BYTES.length, type: '' }, 'video'))
      .rejects.toMatchObject({ code: 'EACCES' });
    await expect(fs.promises.access(assembled)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still rethrows the move error when removing the assembled file also fails', async () => {
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    await expect(adoptChunkedUpload({ path: '/nowhere/x.done', name: 'clip.mov', size: 1, type: '' }, 'video'))
      .rejects.toMatchObject({ code: 'EACCES' });
  });
});
