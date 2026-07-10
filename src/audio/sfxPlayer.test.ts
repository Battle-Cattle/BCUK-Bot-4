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
    existsSync: vi.fn(),
    realpathSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

import { playFile, VoiceNotConnectedError } from './sfxPlayer';
import { isConnected, startPlayback } from './audioPlayer';
import { createAudioResource } from '@discordjs/voice';
import fs from 'fs';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: realpathSync is an identity function (no symlinks)
  vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
});

describe('playFile', () => {
  it('throws VoiceNotConnectedError when not connected to the given guild\'s voice channel', () => {
    vi.mocked(isConnected).mockReturnValue(false);
    expect(() => playFile(path.posix.join(SFX_ROOT, 'ding.mp3'), 'guild-A')).toThrow(VoiceNotConnectedError);
    expect(vi.mocked(isConnected)).toHaveBeenCalledWith('guild-A');
  });

  it('blocks a path that resolves outside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    expect(() => playFile('/etc/passwd', 'guild-A')).toThrow('Path traversal blocked');
  });

  it('blocks a symlink whose real path resolves outside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const outsidePath = '/etc/passwd';
    // Symlink inside SFX_ROOT points to a file outside it
    vi.mocked(fs.realpathSync).mockImplementation((p) =>
      String(p) === SFX_ROOT ? SFX_ROOT : outsidePath,
    );
    expect(() => playFile(path.posix.join(SFX_ROOT, 'evil.mp3'), 'guild-A')).toThrow('Path traversal blocked');
  });

  it('starts playback in the given guild for a valid file inside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);

    const filePath = path.posix.join(SFX_ROOT, 'ding.mp3');
    playFile(filePath, 'guild-A');

    expect(vi.mocked(createAudioResource)).toHaveBeenCalledWith(filePath);
    expect(vi.mocked(startPlayback)).toHaveBeenCalledWith(expect.anything(), 'guild-A');
  });

  it('throws when the sound file does not exist on disk', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => playFile(path.posix.join(SFX_ROOT, 'missing.mp3'), 'guild-A')).toThrow('Sound file not found');
  });

  it('throws when the resolved path is a directory, not a file', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof fs.statSync>);

    expect(() => playFile(path.posix.join(SFX_ROOT, 'notafile'), 'guild-A')).toThrow('Sound path is not a file');
  });
});
