import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/config', () => ({ OVERLAY_FOLDER: '/data/overlay' }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
const { mkdir, rm, storeMov, addVideo } = vi.hoisted(() => ({
  mkdir: vi.fn(async () => {}), rm: vi.fn(async () => {}), storeMov: vi.fn(), addVideo: vi.fn(),
}));
vi.mock('fs', () => ({ default: { promises: { mkdir, rm } } }));
vi.mock('./overlayMovConversion', () => ({ storeMovAsWebm: storeMov }));
vi.mock('../../db', () => ({ addSharedVideo: addVideo }));

import { storeAndRecordSharedVideo, removeSharedVideoFile } from './sharedOverlayVideoStorage';
import { isVideoFileInFlight } from './overlayInFlightFiles';

// path.resolve gives the platform's separators (and a drive letter on Windows).
const sharedDir = path.resolve('/data/overlay', 'shared');
const sharedFile = path.resolve('/data/overlay', 'shared', 'a.webm');
const video = { name: 'Clap', uploadedBy: 'u1' };

/** Makes the conversion store `<baseName>.webm` as storeMovAsWebm does, noting whether it was in flight meanwhile. */
function storeAsWebm(seen: { inFlight?: boolean } = {}): void {
  storeMov.mockImplementation(async (_dir: string, baseName: string) => {
    seen.inFlight = isVideoFileInFlight({ folder: 'shared', filename: `${baseName}.webm` });
    return `${baseName}.webm`;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  storeAsWebm();
  addVideo.mockResolvedValue(4);
});

describe('shared video storage', () => {
  it('converts into the shared folder, creating it first, then records the stored file', async () => {
    const order: string[] = [];
    mkdir.mockImplementation(async () => { order.push('mkdir'); });
    storeMov.mockImplementation(async (dir: string, baseName: string) => { order.push(`store:${dir}`); return `${baseName}.webm`; });
    addVideo.mockImplementation(async () => { order.push('insert'); return 4; });
    const filename = await storeAndRecordSharedVideo(video, async () => {});
    expect(filename).toMatch(/^[\w-]+\.webm$/);
    expect(order).toEqual(['mkdir', `store:${sharedDir}`, 'insert']);
    expect(addVideo).toHaveBeenCalledWith('Clap', filename, 'u1');
    expect(rm).not.toHaveBeenCalled();
  });

  it('passes the source placer and progress listener to the conversion', async () => {
    const place = vi.fn(async () => {});
    const onProgress = vi.fn();
    await storeAndRecordSharedVideo(video, place, onProgress);
    expect(storeMov).toHaveBeenCalledWith(sharedDir, expect.any(String), place, onProgress);
  });

  it('keeps the file marked in flight through the conversion and the insert, and clears it after', async () => {
    const seen: { inFlight?: boolean } = {};
    storeAsWebm(seen);
    let insertSawInFlight = false;
    addVideo.mockImplementation(async (_name: string, filename: string) => {
      insertSawInFlight = isVideoFileInFlight({ folder: 'shared', filename });
      return 4;
    });
    const filename = await storeAndRecordSharedVideo(video, async () => {});
    expect(seen.inFlight).toBe(true);
    expect(insertSawInFlight).toBe(true);
    expect(isVideoFileInFlight({ folder: 'shared', filename })).toBe(false);
  });

  it('removes the file when the insert fails, and only then clears the in-flight mark', async () => {
    let stored = '';
    storeMov.mockImplementation(async (_dir: string, baseName: string) => { stored = `${baseName}.webm`; return stored; });
    addVideo.mockRejectedValue(new Error('db'));
    let removedWhileInFlight = false;
    rm.mockImplementation(async () => { removedWhileInFlight = isVideoFileInFlight({ folder: 'shared', filename: stored }); });
    await expect(storeAndRecordSharedVideo(video, async () => {})).rejects.toThrow('db');
    expect(rm).toHaveBeenCalledWith(path.resolve('/data/overlay', 'shared', stored), { force: true });
    expect(removedWhileInFlight).toBe(true);
    expect(isVideoFileInFlight({ folder: 'shared', filename: stored })).toBe(false);
  });

  it('records nothing and clears the in-flight mark when the conversion fails', async () => {
    let baseName = '';
    storeMov.mockImplementation(async (_dir: string, name: string) => { baseName = name; throw Object.assign(new Error('x'), { code: 'transcode_failed' }); });
    await expect(storeAndRecordSharedVideo(video, async () => {})).rejects.toMatchObject({ code: 'transcode_failed' });
    expect(addVideo).not.toHaveBeenCalled();
    expect(isVideoFileInFlight({ folder: 'shared', filename: `${baseName}.webm` })).toBe(false);
  });

  it('removes a file quietly, ignoring unsafe names', async () => {
    await removeSharedVideoFile('a.webm');
    expect(rm).toHaveBeenCalledWith(sharedFile, { force: true });
    rm.mockClear();
    await removeSharedVideoFile('../a.webm');
    expect(rm).not.toHaveBeenCalled();
    rm.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(removeSharedVideoFile('a.webm')).resolves.toBeUndefined();
  });
});
