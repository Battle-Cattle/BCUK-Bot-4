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

import express from 'express';
import multer from 'multer';
import supertest from 'supertest';
import {
  INCOMING_DIR, overlayUploadStorage, adoptChunkedUpload, detectUploadedVideoType, placeUpload, discardUpload, sweepStaleIncomingUploads,
} from './overlayUploadStorage';
import { STALE_TEMP_FILE_MS } from './overlayFiles';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const MOV_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x14, ...Buffer.from('ftypqt  ', 'ascii'), ...Buffer.alloc(64, 7)]);

/** An app whose one route stores a `video` upload with the real storage engine and reports it. */
function buildApp(maxBytes = 1024 * 1024) {
  const upload = multer({ storage: overlayUploadStorage, limits: { fileSize: maxBytes } }).single('video');
  const app = express();
  app.post('/upload', (req, res) => {
    upload(req, res, (err: unknown) => {
      if (err) {
        res.status(400).json({ error: (err as { code?: string }).code ?? String(err) });
        return;
      }
      res.json({ path: req.file?.path, size: req.file?.size });
    });
  });
  return app;
}

/** A Multer file record for a file the storage engine stored at `fullPath`. */
function fileAt(fullPath: string): Express.Multer.File {
  return { path: fullPath, filename: path.basename(fullPath), originalname: 'clip.mov' } as Express.Multer.File;
}

/** Files currently in the incoming folder, sorted. */
async function incoming() {
  return (await fs.promises.readdir(INCOMING_DIR).catch(() => [] as string[])).sort();
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

describe('overlayUploadStorage', () => {
  it('streams an upload to a random .incoming file inside the overlay folder, creating the folder', async () => {
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.status).toBe(200);
    expect(INCOMING_DIR).toBe(path.join(overlayFolder, '.incoming'));
    expect(path.dirname(res.body.path)).toBe(INCOMING_DIR);
    expect(path.basename(res.body.path)).toMatch(/^[0-9a-f-]{36}\.incoming$/);
    expect(await fs.promises.readFile(res.body.path)).toEqual(MOV_BYTES);
  });

  it('leaves nothing behind when an upload is over the size limit', async () => {
    const res = await supertest(buildApp(16)).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.body.error).toBe('LIMIT_FILE_SIZE');
    expect(await incoming()).toEqual([]);
  });

  it('removes a partly written upload when the write fails, before reporting the error', async () => {
    const realCreate = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(((target: fs.PathLike) => {
      const stream = realCreate(target);
      stream.once('open', () => stream.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' })));
      return stream;
    }) as typeof fs.createWriteStream);
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.body.error).toBe('ENOSPC');
    expect(await incoming()).toEqual([]);
  });

  it('still reports a failed write when removing the partial upload also fails', async () => {
    const realCreate = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(((target: fs.PathLike) => {
      const stream = realCreate(target);
      stream.once('open', () => stream.destroy(Object.assign(new Error('disk full'), { code: 'ENOSPC' })));
      return stream;
    }) as typeof fs.createWriteStream);
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('denied'));
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.body.error).toBe('ENOSPC');
  });

  it('fails the upload when the incoming folder cannot be created', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.status).toBe(400);
  });

  it('fails the upload when mkdir rejects with something other than an Error', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce('nope');
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(res.status).toBe(400);
  });
});

describe('detectUploadedVideoType', () => {
  it('detects the type from the file on disk', async () => {
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    expect(await detectUploadedVideoType(fileAt(res.body.path))).toBe('mov');
  });

  it('returns null for a file that is not a video', async () => {
    const res = await supertest(buildApp()).post('/upload').attach('video', Buffer.from('hello'), 'clip.mov');
    expect(await detectUploadedVideoType(fileAt(res.body.path))).toBeNull();
  });
});

describe('placeUpload', () => {
  /** Stores MOV_BYTES as an upload and returns its file record and a destination path. */
  async function stored() {
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    const dest = path.join(overlayFolder, `dest-${Date.now()}-${Math.random()}.mov.upload`);
    return { file: fileAt(res.body.path), dest };
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
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    await discardUpload(fileAt(res.body.path));
    expect(await incoming()).toEqual([]);
    await expect(discardUpload(fileAt(res.body.path))).resolves.toBeUndefined();
  });

  it('logs instead of throwing when the upload cannot be removed, and can still remove it later', async () => {
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('denied'));
    await expect(discardUpload(fileAt(res.body.path))).resolves.toBeUndefined();
    expect(await incoming()).toHaveLength(1);
    await discardUpload(fileAt(res.body.path));
    expect(await incoming()).toEqual([]);
  });

  it('does nothing once the upload has been moved into place', async () => {
    const res = await supertest(buildApp()).post('/upload').attach('video', MOV_BYTES, 'clip.mov');
    const dest = path.join(overlayFolder, `placed-${Date.now()}.webm`);
    await placeUpload(fileAt(res.body.path), dest);
    const rm = vi.spyOn(fs.promises, 'rm');
    await discardUpload(fileAt(res.body.path));
    expect(rm).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(dest)).toEqual(MOV_BYTES);
  });
});

describe('uploads this process did not store', () => {
  const outside = { path: '/etc/passwd', filename: '../../etc/passwd', originalname: 'clip.mov' } as Express.Multer.File;

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
