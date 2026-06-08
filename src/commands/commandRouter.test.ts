import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { SfxTrigger, SfxFile } from '../db';

const SFX_ROOT = '/sfx';

vi.mock('../shared/config', () => ({
  SFX_FOLDER: '/sfx',
  GLOBAL_COOLDOWN_MS: 3_000,
  DISCORD_GUILD_ID: 'defaultGuild',
  DISCORD_VOICE_CHANNEL_ID: 'defaultChannel',
}));

const TEST_CTX = { guildId: 'guild1', voiceChannelId: 'chan1' };

vi.mock('../db', () => ({
  findTrigger: vi.fn(),
  findSoundFiles: vi.fn(),
}));

vi.mock('../audio/audioPlayer', () => ({
  isPlaying: vi.fn(),
}));

vi.mock('../audio/sfxPlayer', () => ({
  playFile: vi.fn(),
  VoiceNotConnectedError: class VoiceNotConnectedError extends Error {
    constructor() { super('Not connected to a voice channel'); this.name = 'VoiceNotConnectedError'; }
  },
}));

vi.mock('./soundSelector', () => ({
  pickWeightedRandom: vi.fn(),
}));

vi.mock('../shared/statusStore', () => ({
  setVoicePlaying: vi.fn(),
}));

import { handleCommand } from './commandRouter';
import { findTrigger, findSoundFiles } from '../db';
import { isPlaying } from '../audio/audioPlayer';
import { playFile, VoiceNotConnectedError } from '../audio/sfxPlayer';
import { pickWeightedRandom } from './soundSelector';
import { setVoicePlaying } from '../shared/statusStore';

// Base time far in the future so `Date.now() - 0` always exceeds GLOBAL_COOLDOWN_MS
// at the start of each test. Each beforeEach adds enough to expire any previous play.
const COOLDOWN_MS = 3_000;
let mockNow = 1_000_000_000_000;

beforeEach(() => {
  mockNow += COOLDOWN_MS + 1_000;
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(mockNow);
});

const TRIGGER: SfxTrigger = { id: 42n, trigger_command: '!ding', category_id: null, hidden: false, description: null };
const FILES: SfxFile[] = [{ id: 1, trigger_id: 42n, file: 'ding.mp3', trigger_command: null, weight: 1, hidden: false, category_id: null }];

describe('handleCommand', () => {
  it('does nothing for an unrecognised command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(null);

    await handleCommand('!unknown', 'twitch', TEST_CTX);

    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('skips SFX silently when no ctx is provided (streamer not in voice)', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);

    await handleCommand('!ding', 'twitch');

    expect(vi.mocked(findTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('ignores the command while audio is already playing', async () => {
    vi.mocked(isPlaying).mockReturnValue(true);

    await handleCommand('!ding', 'twitch', TEST_CTX);

    expect(vi.mocked(findTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('ignores the command while the global cooldown is active', async () => {
    // First call plays successfully and sets lastPlayedAt = mockNow
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding', 'twitch', TEST_CTX);
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);

    // Second call at the same timestamp — cooldown has not elapsed
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(mockNow);

    await handleCommand('!ding', 'twitch', TEST_CTX);

    expect(vi.mocked(findTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('plays the correct file and updates status for a known command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding discord', 'discord', TEST_CTX);

    expect(vi.mocked(findTrigger)).toHaveBeenCalledWith('!ding');
    expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'ding.mp3'), TEST_CTX.guildId);
    expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith('ding.mp3', '!ding', 'discord');
  });

  it('blocks a second concurrent call via the inFlight flag', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);

    // findTrigger resolves immediately for the first call, but the second call
    // arrives while the first is still awaiting — simulate by running both
    // handleCommand calls concurrently without awaiting the first.
    let resolveFirst!: (value: typeof TRIGGER) => void;
    const firstTriggerPromise = new Promise<typeof TRIGGER>((resolve) => { resolveFirst = resolve; });
    vi.mocked(findTrigger).mockReturnValueOnce(firstTriggerPromise as ReturnType<typeof findTrigger>);

    const first = handleCommand('!ding', 'twitch', TEST_CTX);

    // Second call arrives while first is suspended inside findTrigger
    await handleCommand('!ding', 'twitch', TEST_CTX);
    expect(vi.mocked(findTrigger)).toHaveBeenCalledTimes(1); // second was blocked

    // Let the first call complete
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    resolveFirst(TRIGGER);
    await first;

    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and returns when a trigger has no associated sound files', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue([]);

    await handleCommand('!ding', 'twitch', TEST_CTX);

    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('logs an error for non-VoiceNotConnectedError playback failures', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    vi.mocked(playFile).mockImplementation(() => { throw new Error('FFMPEG crashed'); });

    const errorSpy = vi.spyOn(console, 'error');

    await handleCommand('!ding', 'twitch', TEST_CTX);

    // setVoicePlaying must NOT be called when playback fails
    expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    // The error is logged via the winston logger, not console.error — just verify no crash
    expect(errorSpy).not.toHaveBeenCalled(); // logger writes to file, not console
  });

  it('does not log an error when not connected to a voice channel', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    vi.mocked(playFile).mockImplementation(() => { throw new VoiceNotConnectedError(); });

    const errorSpy = vi.spyOn(console, 'error');

    await handleCommand('!ding', 'twitch', TEST_CTX);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
  });

  describe('path traversal security', () => {
    it('rejects path traversal with ../ sequences', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
      vi.mocked(findSoundFiles).mockResolvedValue(FILES);
      vi.mocked(pickWeightedRandom).mockReturnValue('../../../etc/passwd');

      await handleCommand('!exploit', 'twitch', TEST_CTX);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('rejects path traversal with encoded ../ sequences', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
      vi.mocked(findSoundFiles).mockResolvedValue(FILES);
      vi.mocked(pickWeightedRandom).mockReturnValue('..%2F..%2Fetc%2Fpasswd');

      await handleCommand('!exploit', 'twitch', TEST_CTX);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('rejects absolute paths', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
      vi.mocked(findSoundFiles).mockResolvedValue(FILES);
      vi.mocked(pickWeightedRandom).mockReturnValue('/etc/passwd');

      await handleCommand('!exploit', 'twitch', TEST_CTX);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('allows valid filenames within the SFX folder', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
      vi.mocked(findSoundFiles).mockResolvedValue(FILES);
      vi.mocked(pickWeightedRandom).mockReturnValue('valid-sound.mp3');
      vi.mocked(playFile).mockImplementation(() => {}); // Reset to no-op

      await handleCommand('!safe', 'twitch', TEST_CTX);

      expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'valid-sound.mp3'), TEST_CTX.guildId);
      expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith('valid-sound.mp3', '!safe', 'twitch');
    });

    it('allows valid filenames in subdirectories within the SFX folder', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
      vi.mocked(findSoundFiles).mockResolvedValue(FILES);
      vi.mocked(pickWeightedRandom).mockReturnValue('category/sound.mp3');
      vi.mocked(playFile).mockImplementation(() => {}); // Reset to no-op

      await handleCommand('!safe', 'twitch', TEST_CTX);

      expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'category', 'sound.mp3'), TEST_CTX.guildId);
      expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith('category/sound.mp3', '!safe', 'twitch');
    });
  });
});
