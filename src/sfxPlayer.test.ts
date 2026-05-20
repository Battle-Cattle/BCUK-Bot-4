import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config', () => ({ SFX_FOLDER: '/sfx' }));

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
  it('throws VoiceNotConnectedError when not connected to a voice channel', () => {
    vi.mocked(isConnected).mockReturnValue(false);
    expect(() => playFile('/sfx/ding.mp3')).toThrow(VoiceNotConnectedError);
  });

  it('blocks a path that resolves outside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    expect(() => playFile('/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks a symlink whose real path resolves outside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Symlink inside /sfx points to a file outside /sfx
    vi.mocked(fs.realpathSync).mockImplementation((p) =>
      String(p) === '/sfx' ? '/sfx' : '/etc/passwd',
    );
    expect(() => playFile('/sfx/evil.mp3')).toThrow('Path traversal blocked');
  });

  it('starts playback for a valid file inside the SFX folder', () => {
    vi.mocked(isConnected).mockReturnValue(true);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof fs.statSync>);

    playFile('/sfx/ding.mp3');

    expect(vi.mocked(createAudioResource)).toHaveBeenCalledWith('/sfx/ding.mp3');
    expect(vi.mocked(startPlayback)).toHaveBeenCalledOnce();
  });
});
