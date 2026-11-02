import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createMutationQueue } from '../../shared/mutationQueue';

// Converts uploaded QuickTime (.mov) overlay videos to WebM. Editors export transparent video as
// MOV (ProRes 4444, QuickTime Animation, PNG-in-MOV), which browsers — and so OBS's browser
// source — can't play. VP9 WebM with an alpha channel is what the overlay page can play with
// transparency intact.

/** Kills ffmpeg and rejects if one conversion hasn't finished within this long. */
export const WEBM_TRANSCODE_TIMEOUT_MS = 5 * 60_000;

/** Keeps at most this many characters of ffmpeg's stderr in a failure's error message. */
const STDERR_TAIL_CHARS = 500;

/**
 * Serialises conversions: VP9 encoding uses every core it can get, and the bot is a single
 * process that also has to keep chat and voice responsive, so uploads convert one at a time.
 */
const transcodeQueue = createMutationQueue<'webm'>();

/**
 * Builds the ffmpeg arguments that convert `inputPath` to a VP9/Opus WebM at `outputPath`.
 * `yuva420p` keeps the alpha channel (an opaque source just gets a fully opaque one), and
 * `-auto-alt-ref 0` is needed because libvpx drops alpha when alt-ref frames are on. Only the
 * first video stream and, if there is one, the first audio stream are kept, and metadata is
 * dropped so nothing from the uploader's machine ends up in the served file.
 * @param inputPath - Absolute path of the uploaded source video.
 * @param outputPath - Absolute path to write the WebM to.
 * @returns The argument list to pass to ffmpeg.
 */
export function buildWebmTranscodeArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
    '-c:a', 'libopus', '-b:a', '128k',
    '-f', 'webm', outputPath,
  ];
}

/**
 * Runs the bundled ffmpeg with `args`, killing it and rejecting if it hasn't exited within
 * {@link WEBM_TRANSCODE_TIMEOUT_MS}.
 * @param args - Arguments to pass to ffmpeg.
 * @returns Resolves once ffmpeg exits with code 0.
 * @throws If ffmpeg can't be started, exits non-zero (the message carries the end of its
 *   stderr) or times out.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static returned no path'));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg WebM conversion timed out after ${WEBM_TRANSCODE_TIMEOUT_MS}ms`));
    }, WEBM_TRANSCODE_TIMEOUT_MS);
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        const tail = Buffer.concat(stderr).toString('utf8').slice(-STDERR_TAIL_CHARS);
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
      }
    });
  });
}

/**
 * Converts the video at `inputPath` to a transparent-capable VP9 WebM at `outputPath`, waiting
 * for any conversion already running to finish first. The caller owns both files, including
 * removing a partial `outputPath` if this rejects.
 * @param inputPath - Absolute path of the uploaded source video.
 * @param outputPath - Absolute path to write the WebM to.
 * @returns Resolves once the WebM has been written.
 * @throws If ffmpeg fails or times out.
 */
export function transcodeToWebm(inputPath: string, outputPath: string): Promise<void> {
  return transcodeQueue.run('webm', () => runFfmpeg(buildWebmTranscodeArgs(inputPath, outputPath)));
}
