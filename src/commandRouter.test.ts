import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config', () => ({
  SFX_FOLDER: '/sfx',
  GLOBAL_COOLDOWN_MS: 3_000,
}));

vi.mock('./db', () => ({
  findTrigger: vi.fn(),
  findSoundFiles: vi.fn(),
}));

vi.mock('./audioPlayer', () => ({
  isPlaying: vi.fn(),
}));

vi.mock('./sfxPlayer', () => ({
  playFile: vi.fn(),
}));

vi.mock('./soundSelector', () => ({
  pickWeightedRandom: vi.fn(),
}));

vi.mock('./statusStore', () => ({
  setVoicePlaying: vi.fn(),
}));

import { handleCommand } from './commandRouter';
import { findTrigger, findSoundFiles } from './db';
import { isPlaying } from './audioPlayer';
import { playFile } from './sfxPlayer';
import { pickWeightedRandom } from './soundSelector';
import { setVoicePlaying } from './statusStore';

// Base time far in the future so `Date.now() - 0` always exceeds GLOBAL_COOLDOWN_MS
// at the start of each test. Each beforeEach adds enough to expire any previous play.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);
});

const TRIGGER = { id: 42, trigger_command: '!ding' };
const FILES = [{ file: 'ding.mp3', weight: 1 }];

describe('handleCommand', () => {
  it('does nothing for an unrecognised command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(null);

    await handleCommand('!unknown', 'twitch');

    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('ignores the command while audio is already playing', async () => {
    vi.mocked(isPlaying).mockReturnValue(true);

    await handleCommand('!ding', 'twitch');

    expect(vi.mocked(findTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('ignores the command while the global cooldown is active', async () => {
    // First call plays successfully and sets lastPlayedAt = mockNow
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding', 'twitch');
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);

    // Second call at the same timestamp — cooldown has not elapsed
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(mockNow);

    await handleCommand('!ding', 'twitch');

    expect(vi.mocked(findTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('plays the correct file and updates status for a known command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding discord', 'discord');

    expect(vi.mocked(findTrigger)).toHaveBeenCalledWith('!ding');
    expect(vi.mocked(playFile)).toHaveBeenCalledWith('/sfx/ding.mp3');
    expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith('ding.mp3', '!ding', 'discord');
  });
});
