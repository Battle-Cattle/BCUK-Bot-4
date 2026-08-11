import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { SfxTrigger, SfxFile, SfxLookupResult } from '../db';

const SFX_ROOT = '/sfx';

vi.mock('../shared/config', () => ({
  SFX_FOLDER: '/sfx',
  GLOBAL_COOLDOWN_MS: 3_000,
}));

vi.mock('../db', () => ({
  findCachedSfxTrigger: vi.fn(),
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

import { handleCommand, forgetGuildCommandState } from './commandRouter';
import { findCachedSfxTrigger } from '../db';
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
const LOOKUP: SfxLookupResult = { trigger: TRIGGER, files: FILES };
const GUILD_A = 'guild-A';
const GUILD_B = 'guild-B';

describe('handleCommand', () => {
  it('does nothing for an unrecognised command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(null);

    await handleCommand('!unknown', 'twitch', GUILD_A);

    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('skips without warning when no guild is resolved and the message is not a known trigger', async () => {
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(null);

    await handleCommand('just chatting about stuff', 'twitch', null);

    expect(vi.mocked(findCachedSfxTrigger)).toHaveBeenCalledWith('just');
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('skips with a warning when a known trigger fires but no guild is resolved', async () => {
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);

    await handleCommand('!ding', 'twitch', null);

    expect(vi.mocked(findCachedSfxTrigger)).toHaveBeenCalledWith('!ding');
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('ignores the command while audio is already playing in that guild', async () => {
    vi.mocked(isPlaying).mockReturnValue(true);

    await handleCommand('!ding', 'twitch', GUILD_A);

    expect(vi.mocked(findCachedSfxTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
    expect(vi.mocked(isPlaying)).toHaveBeenCalledWith(GUILD_A);
  });

  it('ignores the command while the per-guild cooldown is active', async () => {
    // First call plays successfully and sets this guild's lastPlayedAt = mockNow
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding', 'twitch', GUILD_A);
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);

    // Second call at the same timestamp — cooldown has not elapsed
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(mockNow);

    await handleCommand('!ding', 'twitch', GUILD_A);

    expect(vi.mocked(findCachedSfxTrigger)).not.toHaveBeenCalled();
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('does not apply one guild\'s cooldown to another guild', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding', 'twitch', GUILD_A);
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);

    // Same timestamp, but a different guild — its own cooldown has not started yet.
    await handleCommand('!ding', 'twitch', GUILD_B);

    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(2);
  });

  it('forgetGuildCommandState resets a guild\'s cooldown so a subsequent command fires immediately', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding', 'twitch', GUILD_A);
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);

    forgetGuildCommandState(GUILD_A);

    // Same timestamp — without forgetting, this would be blocked by the cooldown.
    await handleCommand('!ding', 'twitch', GUILD_A);
    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(2);
  });

  it('forgetGuildCommandState is a no-op for a guild with no state', () => {
    expect(() => forgetGuildCommandState('never-seen')).not.toThrow();
  });

  it('plays the correct file and updates status for a known command', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    await handleCommand('!ding discord', 'discord', GUILD_A);

    expect(vi.mocked(findCachedSfxTrigger)).toHaveBeenCalledWith('!ding');
    expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'ding.mp3'), GUILD_A);
    expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith(GUILD_A, 'ding.mp3', '!ding', 'discord');
  });

  it('blocks a second concurrent call via the inFlight flag', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);

    // findCachedSfxTrigger resolves immediately for the first call, but the second call
    // arrives while the first is still awaiting — simulate by running both
    // handleCommand calls concurrently without awaiting the first.
    let resolveFirst!: (value: SfxLookupResult) => void;
    const firstLookupPromise = new Promise<SfxLookupResult>((resolve) => { resolveFirst = resolve; });
    vi.mocked(findCachedSfxTrigger).mockReturnValueOnce(firstLookupPromise as ReturnType<typeof findCachedSfxTrigger>);

    const first = handleCommand('!ding', 'twitch', GUILD_A);

    // Second call arrives while first is suspended inside findCachedSfxTrigger
    await handleCommand('!ding', 'twitch', GUILD_A);
    expect(vi.mocked(findCachedSfxTrigger)).toHaveBeenCalledTimes(1); // second was blocked

    // Let the first call complete
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    resolveFirst(LOOKUP);
    await first;

    expect(vi.mocked(playFile)).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and returns when a trigger has no associated sound files', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue({ trigger: TRIGGER, files: [] });

    await handleCommand('!ding', 'twitch', GUILD_A);

    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('logs an error for non-VoiceNotConnectedError playback failures', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    vi.mocked(playFile).mockImplementation(() => { throw new Error('FFMPEG crashed'); });

    const errorSpy = vi.spyOn(console, 'error');

    await handleCommand('!ding', 'twitch', GUILD_A);

    // setVoicePlaying must NOT be called when playback fails
    expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    // The error is logged via the winston logger, not console.error — just verify no crash
    expect(errorSpy).not.toHaveBeenCalled(); // logger writes to file, not console
  });

  it('does not log an error when not connected to a voice channel', async () => {
    vi.mocked(isPlaying).mockReturnValue(false);
    vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
    vi.mocked(playFile).mockImplementation(() => { throw new VoiceNotConnectedError(); });

    const errorSpy = vi.spyOn(console, 'error');

    await handleCommand('!ding', 'twitch', GUILD_A);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
  });

  describe('path traversal security', () => {
    it('rejects path traversal with ../ sequences', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
      vi.mocked(pickWeightedRandom).mockReturnValue('../../../etc/passwd');

      await handleCommand('!exploit', 'twitch', GUILD_A);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('rejects path traversal with encoded ../ sequences', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
      vi.mocked(pickWeightedRandom).mockReturnValue('..%2F..%2Fetc%2Fpasswd');

      await handleCommand('!exploit', 'twitch', GUILD_A);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('rejects absolute paths', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
      vi.mocked(pickWeightedRandom).mockReturnValue('/etc/passwd');

      await handleCommand('!exploit', 'twitch', GUILD_A);

      expect(vi.mocked(playFile)).not.toHaveBeenCalled();
      expect(vi.mocked(setVoicePlaying)).not.toHaveBeenCalled();
    });

    it('allows valid filenames within the SFX folder', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
      vi.mocked(pickWeightedRandom).mockReturnValue('valid-sound.mp3');
      vi.mocked(playFile).mockResolvedValue(undefined); // Reset to no-op

      await handleCommand('!safe', 'twitch', GUILD_A);

      expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'valid-sound.mp3'), GUILD_A);
      expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith(GUILD_A, 'valid-sound.mp3', '!safe', 'twitch');
    });

    it('allows valid filenames in subdirectories within the SFX folder', async () => {
      vi.mocked(isPlaying).mockReturnValue(false);
      vi.mocked(findCachedSfxTrigger).mockResolvedValue(LOOKUP);
      vi.mocked(pickWeightedRandom).mockReturnValue('category/sound.mp3');
      vi.mocked(playFile).mockResolvedValue(undefined); // Reset to no-op

      await handleCommand('!safe', 'twitch', GUILD_A);

      expect(vi.mocked(playFile)).toHaveBeenCalledWith(path.posix.join(SFX_ROOT, 'category', 'sound.mp3'), GUILD_A);
      expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith(GUILD_A, 'category/sound.mp3', '!safe', 'twitch');
    });
  });
});
