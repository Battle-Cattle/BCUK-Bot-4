import { createLogger } from '../shared/logger';
import { createAudioResource, demuxProbe, StreamType } from '@discordjs/voice';
import type { Readable } from 'stream';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import { SFX_FOLDER } from '../shared/config';
import { isReady, startPlayback } from './audioPlayer';
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

/**
 * Returns the SFX folder's canonical (symlink-resolved) real path, resolving and caching it on first call.
 * @returns Absolute real path of the SFX folder.
 */
function getRealSfxRoot(): string {
  if (!realSfxRoot) {
    realSfxRoot = fs.realpathSync(sfxRoot);
  }
  return realSfxRoot;
}

/** Extensions whose files may already hold Opus audio that Discord can take without re-encoding. */
const OPUS_CONTAINER_EXTENSIONS = new Set(['.ogg', '.opus', '.webm']);

/** What {@link createAudioResource} is given for one sound: a file path for ffmpeg, or a probed stream. */
interface SfxInput {
  input: string | Readable;
  inputType: StreamType;
}

/**
 * Works out how to feed a sound file to the player. A file in an Opus container is probed: when
 * it holds 48kHz stereo Opus its packets go to Discord as they are, skipping the ffmpeg spawn and
 * Opus encode every other file pays before its first frame. Anything else (including Ogg Vorbis)
 * goes through ffmpeg as before. Only the probe reads the file; nothing is spawned here.
 * @param filePath - Absolute, already-validated path of the sound file.
 * @returns The path or probed stream to play, with its stream type.
 */
async function prepareSfxInput(filePath: string): Promise<SfxInput> {
  if (!OPUS_CONTAINER_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { input: filePath, inputType: StreamType.Arbitrary };
  }
  const { stream, type } = await demuxProbe(fs.createReadStream(filePath));
  return { input: stream, inputType: type };
}

/**
 * Play a local sound file into the given guild's connected voice channel.
 * Throws if that guild's voice connection isn't Ready (checked both before and after
 * resolving the file; a connection that's recovering from a drop counts as not connected,
 * since a sound started then plays late or never) or the file does not exist.
 *
 * @param filePath - Sound file path, relative to the SFX folder.
 * @param guildId - Guild whose voice connection to play the file into.
 */
export async function playFile(filePath: string, guildId: string): Promise<void> {
  if (!isReady(guildId)) {
    throw new VoiceNotConnectedError();
  }

  const candidatePath = safeResolve(sfxRoot, filePath);
  if (!candidatePath) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  let resolved: string;
  try {
    resolved = await fs.promises.realpath(candidatePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Sound file not found: ${candidatePath}`, { cause: err });
    }
    throw err;
  }

  // Resolve symlinks and verify the final real path is still inside the SFX root.
  if (!safeResolve(getRealSfxRoot(), resolved)) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside SFX folder`);
  }

  const fileStats = await fs.promises.stat(resolved);
  if (!fileStats.isFile()) {
    throw new Error(`Sound path is not a file: ${resolved}`);
  }

  const { input, inputType } = await prepareSfxInput(resolved);

  // Re-check after the realpath/stat/probe awaits: the guild may have disconnected (or been
  // forgotten) meanwhile, and startPlayback would otherwise recreate its state and play
  // into a player no connection is subscribed to.
  if (!isReady(guildId)) {
    if (typeof input !== 'string') input.destroy();
    throw new VoiceNotConnectedError();
  }

  startPlayback(createAudioResource(input, { inputType }), guildId);
}
