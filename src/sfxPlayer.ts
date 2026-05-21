import { createLogger } from './logger';
import { createAudioResource } from '@discordjs/voice';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { SFX_FOLDER } from './config';
import { isConnected, startPlayback } from './audioPlayer';

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

const sfxRoot = path.resolve(SFX_FOLDER);
let realSfxRoot: string | null = null;

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function getRealSfxRoot(): string {
  if (!realSfxRoot) {
    realSfxRoot = fs.realpathSync(sfxRoot);
  }
  return realSfxRoot;
}

/**
 * Play a local sound file into the connected voice channel.
 * Throws if not connected or the file does not exist.
 */
export function playFile(filePath: string): void {
  if (!isConnected()) {
    throw new VoiceNotConnectedError();
  }

  const candidatePath = path.resolve(filePath);

  // Reject obvious traversal attempts before touching the filesystem.
  if (!isPathInsideRoot(sfxRoot, candidatePath)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`Sound file not found: ${candidatePath}`);
  }

  const resolved = fs.realpathSync(candidatePath);

  // Resolve symlinks and verify the final real path is still inside the SFX root.
  if (!isPathInsideRoot(getRealSfxRoot(), resolved)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  const fileStats = fs.statSync(resolved);
  if (!fileStats.isFile()) {
    throw new Error(`Sound path is not a file: ${resolved}`);
  }

  startPlayback(createAudioResource(resolved));
}
