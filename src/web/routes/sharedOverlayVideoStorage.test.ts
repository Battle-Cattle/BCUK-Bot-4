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

import { storeSharedVideo, removeSharedVideoFile, recordSharedVideo } from './sharedOverlayVideoStorage';

beforeEach(() => { vi.clearAllMocks(); });

describe('shared video storage', () => {
  it('converts into the shared folder, creating it first', async () => {
    const order: string[] = [];
    mkdir.mockImplementation(async () => { order.push('mkdir'); });
    storeMov.mockImplementation(async (dir: string) => { order.push(`store:${dir}`); return 'x.webm'; });
    await expect(storeSharedVideo(async () => {})).resolves.toBe('x.webm');
    expect(order).toEqual(['mkdir', 'store:/data/overlay/shared']);
  });

  it('removes a file quietly, ignoring unsafe names', async () => {
    await removeSharedVideoFile('a.webm');
    expect(rm).toHaveBeenCalledWith('/data/overlay/shared/a.webm', { force: true });
    rm.mockClear();
    await removeSharedVideoFile('../a.webm');
    expect(rm).not.toHaveBeenCalled();
    rm.mockRejectedValueOnce(new Error('EBUSY'));
    await expect(removeSharedVideoFile('a.webm')).resolves.toBeUndefined();
  });

  it('records a video and keeps the file', async () => {
    addVideo.mockResolvedValue(4);
    await expect(recordSharedVideo('Clap', 'a.webm', 'u1')).resolves.toBe(4);
    expect(rm).not.toHaveBeenCalled();
  });

  it('removes the file when the insert fails', async () => {
    addVideo.mockRejectedValue(new Error('db'));
    await expect(recordSharedVideo('Clap', 'a.webm', 'u1')).rejects.toThrow('db');
    expect(rm).toHaveBeenCalledWith('/data/overlay/shared/a.webm', { force: true });
  });
});
