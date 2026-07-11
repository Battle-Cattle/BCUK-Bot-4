import { createLogger } from '../shared/logger';
import { createAudioResource } from '@discordjs/voice';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { SFX_FOLDER } from '../shared/config';
import { isConnected, startPlayback } from './audioPlayer';
import { safeResolve } from '../shared/pathUtils';

const log = createLogger('SFXPlayer');

export class VoiceNotConnectedError extends Error {
  constructor() {
    super('Not connected to a voice channel');
    this.name = 'VoiceNotConnectedError';
  }
}

// Tell @discordjs/voice where the ffmpeg binary is
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
} else {
  log.warn('ffmpeg-static returned no path!');
}

const sfxRoot = path.posix.resolve(SFX_FOLDER);
let realSfxRoot: string | null = null;

function getRealSfxRoot(): string {
  if (!realSfxRoot) {
    realSfxRoot = fs.realpathSync(sfxRoot);
  }
  return realSfxRoot;
}

/**
 * Play a local sound file into the given guild's connected voice channel.
 * Throws if that guild isn't connected or the file does not exist.
 *
 * @param filePath - Sound file path, relative to the SFX folder.
 * @param guildId - Guild whose voice connection to play the file into.
 */
export function playFile(filePath: string, guildId: string): void {
  if (!isConnected(guildId)) {
    throw new VoiceNotConnectedError();
  }

  const candidatePath = safeResolve(sfxRoot, filePath);
  if (!candidatePath) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`Sound file not found: ${candidatePath}`);
  }

  const resolved = fs.realpathSync(candidatePath);

  // Resolve symlinks and verify the final real path is still inside the SFX root.
  if (!safeResolve(getRealSfxRoot(), resolved)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  const fileStats = fs.statSync(resolved);
  if (!fileStats.isFile()) {
    throw new Error(`Sound path is not a file: ${resolved}`);
  }

  startPlayback(createAudioResource(resolved), guildId);
}
