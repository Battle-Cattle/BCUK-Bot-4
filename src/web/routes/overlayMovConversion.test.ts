import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./overlayVideoTranscode', () => ({ transcodeToWebm: vi.fn() }));

import { transcodeToWebm } from './overlayVideoTranscode';
import { storeMovAsWebm, sweepStaleConversionFiles, STALE_CONVERSION_FILE_MS } from './overlayMovConversion';

const MOV_BYTES = Buffer.from('fake mov bytes');
let dir: string;
/** What the most recent conversion read from its input file. */
let convertedInput: Buffer | undefined;

/** Lists the folder's files, sorted. */
async function files() {
  return (await fs.promises.readdir(dir)).sort();
}

/** Writes `name` into the folder with a modification time `ageMs` in the past. */
async function writeAged(name: string, ageMs: number) {
  const fullPath = path.join(dir, name);
  await fs.promises.writeFile(fullPath, 'x');
  const time = new Date(Date.now() - ageMs);
  await fs.promises.utimes(fullPath, time, time);
}

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overlay-mov-'));
  // A successful conversion writes the output file it was given.
  convertedInput = undefined;
  vi.mocked(transcodeToWebm).mockImplementation(async (inputPath, outputPath) => {
    convertedInput = await fs.promises.readFile(inputPath);
    await fs.promises.writeFile(outputPath, 'webm bytes');
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('storeMovAsWebm', () => {
  it('converts the upload and leaves only the finished WebM', async () => {
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).resolves.toBe('abc.webm');
    expect(vi.mocked(transcodeToWebm)).toHaveBeenCalledWith(path.join(dir, 'abc.mov.upload'), path.join(dir, 'abc.webm.part'));
    expect(convertedInput).toEqual(MOV_BYTES);
    expect(await files()).toEqual(['abc.webm']);
    expect(await fs.promises.readFile(path.join(dir, 'abc.webm'), 'utf8')).toBe('webm bytes');
  });

  it('removes both temporary files and reports transcode_failed when ffmpeg fails partway', async () => {
    vi.mocked(transcodeToWebm).mockImplementation(async (_inputPath, outputPath) => {
      await fs.promises.writeFile(outputPath, 'half a webm');
      throw new Error('ffmpeg exited with code 1');
    });
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).rejects.toMatchObject({ code: 'transcode_failed' });
    expect(await files()).toEqual([]);
  });

  it('reports transcode_busy when the conversion queue is full', async () => {
    vi.mocked(transcodeToWebm).mockRejectedValue(Object.assign(new Error('full'), { code: 'transcode_busy' }));
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).rejects.toMatchObject({ code: 'transcode_busy' });
    expect(await files()).toEqual([]);
  });

  it('reports transcode_failed when something other than an Error is thrown', async () => {
    vi.mocked(transcodeToWebm).mockRejectedValue('not an Error');
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).rejects.toMatchObject({ code: 'transcode_failed' });
  });

  it('still reports the conversion failure when removing the temporary files also fails', async () => {
    vi.mocked(transcodeToWebm).mockRejectedValue(new Error('ffmpeg exited with code 1'));
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).rejects.toMatchObject({ code: 'transcode_failed' });
  });

  it('removes a partial temporary copy and rethrows when writing it fails', async () => {
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await expect(storeMovAsWebm(dir, 'abc', MOV_BYTES)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(vi.mocked(transcodeToWebm)).not.toHaveBeenCalled();
    expect(await files()).toEqual([]);
  });

  it('sweeps stale temporary files from earlier uploads before converting', async () => {
    await writeAged('old.mov.upload', STALE_CONVERSION_FILE_MS + 60_000);
    await storeMovAsWebm(dir, 'abc', MOV_BYTES);
    expect(await files()).toEqual(['abc.webm']);
  });
});

describe('sweepStaleConversionFiles', () => {
  it('removes stale temporary MOV copies and partial WebMs', async () => {
    await writeAged('a.mov.upload', STALE_CONVERSION_FILE_MS + 60_000);
    await writeAged('b.webm.part', STALE_CONVERSION_FILE_MS + 60_000);
    await sweepStaleConversionFiles(dir);
    expect(await files()).toEqual([]);
  });

  it('keeps temporary files an upload may still be using', async () => {
    await writeAged('a.mov.upload', 60_000);
    await writeAged('b.webm.part', 60_000);
    await sweepStaleConversionFiles(dir);
    expect(await files()).toEqual(['a.mov.upload', 'b.webm.part']);
  });

  it('never touches stored videos, however old', async () => {
    await writeAged('a.webm', STALE_CONVERSION_FILE_MS * 10);
    await writeAged('b.mp4', STALE_CONVERSION_FILE_MS * 10);
    await sweepStaleConversionFiles(dir);
    expect(await files()).toEqual(['a.webm', 'b.mp4']);
  });

  it('does nothing when the folder cannot be listed', async () => {
    await expect(sweepStaleConversionFiles(path.join(dir, 'missing'))).resolves.toBeUndefined();
  });

  it('keeps going when one file cannot be checked', async () => {
    await writeAged('a.mov.upload', STALE_CONVERSION_FILE_MS + 60_000);
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(sweepStaleConversionFiles(dir)).resolves.toBeUndefined();
  });
});
