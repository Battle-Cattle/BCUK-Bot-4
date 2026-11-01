import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/pathUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
  return { ...actual, realPathWithin: vi.fn() };
});

import type { Response } from 'express';
import { realPathWithin } from '../../shared/pathUtils';
import { resolveStreamerFile, sendStreamerFile } from './streamerFileServing';

const FOLDER = '/srv/files';
const FILENAME_RE = /^[\w-]+\.(png|mp4)$/i;

function mockRes(headersSent = false) {
  const res = {
    headersSent,
    status: vi.fn(),
    end: vi.fn(),
    sendFile: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.mocked(realPathWithin).mockReset();
});

describe('resolveStreamerFile', () => {
  it('returns the real path and filename match for a valid request', async () => {
    vi.mocked(realPathWithin).mockResolvedValue('/srv/files/12/clip.MP4');
    const res = mockRes();
    const file = await resolveStreamerFile(res as unknown as Response, FOLDER, { streamerId: '12', filename: 'clip.MP4' }, FILENAME_RE);
    expect(file?.realPath).toBe('/srv/files/12/clip.MP4');
    expect(file?.match[1]).toBe('MP4');
    expect(realPathWithin).toHaveBeenCalledWith(FOLDER, '/srv/files/12/clip.MP4');
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-numeric streamer id', { streamerId: '1a', filename: 'clip.mp4' }],
    ['a traversal streamer id', { streamerId: '..', filename: 'clip.mp4' }],
    ['a filename outside the pattern', { streamerId: '12', filename: 'clip.exe' }],
    ['a filename with a path separator', { streamerId: '12', filename: '../clip.mp4' }],
  ])('replies 400 for %s without touching the filesystem', async (_label, params) => {
    const res = mockRes();
    expect(await resolveStreamerFile(res as unknown as Response, FOLDER, params, FILENAME_RE)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.end).toHaveBeenCalled();
    expect(realPathWithin).not.toHaveBeenCalled();
  });

  it('replies 404 when the real path is missing or escapes the folder', async () => {
    vi.mocked(realPathWithin).mockResolvedValue(null);
    const res = mockRes();
    expect(await resolveStreamerFile(res as unknown as Response, FOLDER, { streamerId: '12', filename: 'clip.mp4' }, FILENAME_RE)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('replies 404 when resolving the real path throws', async () => {
    vi.mocked(realPathWithin).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const res = mockRes();
    expect(await resolveStreamerFile(res as unknown as Response, FOLDER, { streamerId: '12', filename: 'clip.mp4' }, FILENAME_RE)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('sendStreamerFile', () => {
  it('sends the file and does nothing more on success', () => {
    const res = mockRes();
    res.sendFile.mockImplementation((_path: string, cb: (err?: Error) => void) => cb());
    sendStreamerFile(res as unknown as Response, '/srv/files/12/clip.mp4');
    expect(res.sendFile).toHaveBeenCalledWith('/srv/files/12/clip.mp4', expect.any(Function));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('replies 404 when the file vanishes before it is sent', () => {
    const res = mockRes();
    res.sendFile.mockImplementation((_path: string, cb: (err?: Error) => void) => cb(new Error('ENOENT')));
    sendStreamerFile(res as unknown as Response, '/srv/files/12/clip.mp4');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('leaves the response alone when the send fails after headers went out', () => {
    const res = mockRes(true);
    res.sendFile.mockImplementation((_path: string, cb: (err?: Error) => void) => cb(new Error('aborted')));
    sendStreamerFile(res as unknown as Response, '/srv/files/12/clip.mp4');
    expect(res.status).not.toHaveBeenCalled();
  });
});
