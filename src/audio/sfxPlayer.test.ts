import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('../shared/config', () => ({ SFX_FOLDER: '/sfx' }));

const SFX_ROOT = '/sfx';

vi.mock('./audioPlayer', () => ({
  isConnected: vi.fn(),
  startPlayback: vi.fn(),
}));

vi.mock('@discordjs/voice', () => ({
  createAudioResource: vi.fn((p: string) => ({ resourcePath: p })),
}));

vi.mock('ffmpeg-static', () => ({ default: null }));

vi.mock('fs', () => ({
  default: {
    realpathSync: vi.fn(),
    promises: {
      realpath: vi.fn(),
      stat: vi.fn(),
    },
  },
}));

import { playFile, VoiceNotConnectedError } from './sfxPlayer';
import { isConnected, startPlayback } from './audioPlayer';
import { createAudioResource } from '@discordjs/voice';
import fs from 'fs';

/** Builds an ENOENT-style error, matching what fs.promises.realpath throws for a missing path. */
function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: realpathSync/realpath are identity functions (no symlinks)
  vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
  vi.mocked(fs.promises.realpath).mockImplementation(async (p) => p as string);
});

describe('playFile', () => {
  it('throws VoiceNotConnectedError when not connected to the given guild\'s voice channel', async () => {
    vi.mocked(isConnected).mockReturnValue(false);
    await expect(playFile(path.posix.join(SFX_ROOT, 'ding.mp3'), 'guild-A')).rejects.toThrow(VoiceNotConnectedError);
    expect(vi.mocked(isConnected)).toHaveBeenCalledWith('guild-A');
  });

  it('blocks a path that resolves outside the SFX folder', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    await expect(playFile('/etc/passwd', 'guild-A')).rejects.toThrow('Path traversal blocked');
  });

  it('blocks a symlink whose real path resolves outside the SFX folder', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    const outsidePath = '/etc/passwd';
    // Symlink inside SFX_ROOT points to a file outside it
    vi.mocked(fs.promises.realpath).mockImplementation(async (p) =>
      String(p) === SFX_ROOT ? SFX_ROOT : outsidePath,
    );
    await expect(playFile(path.posix.join(SFX_ROOT, 'evil.mp3'), 'guild-A')).rejects.toThrow('Path traversal blocked');
  });

  it('starts playback in the given guild for a valid file inside the SFX folder', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof fs.promises.stat>>);

    const filePath = path.posix.join(SFX_ROOT, 'ding.mp3');
    await playFile(filePath, 'guild-A');

    expect(vi.mocked(createAudioResource)).toHaveBeenCalledWith(filePath);
    expect(vi.mocked(startPlayback)).toHaveBeenCalledWith(expect.anything(), 'guild-A');
  });

  it('throws when the sound file does not exist on disk', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.promises.realpath).mockRejectedValue(enoent());

    await expect(playFile(path.posix.join(SFX_ROOT, 'missing.mp3'), 'guild-A')).rejects.toThrow('Sound file not found');
  });

  it('propagates a non-ENOENT realpath error rather than misreporting it as a missing file', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.promises.realpath).mockRejectedValue(new Error('EACCES'));

    await expect(playFile(path.posix.join(SFX_ROOT, 'locked.mp3'), 'guild-A')).rejects.toThrow('EACCES');
  });

  it('throws when the resolved path is a directory, not a file', async () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.promises.stat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof fs.promises.stat>>);

    await expect(playFile(path.posix.join(SFX_ROOT, 'notafile'), 'guild-A')).rejects.toThrow('Sound path is not a file');
  });
});
