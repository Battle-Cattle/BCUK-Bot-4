import { spawn, type ChildProcess } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import { createLogger } from '../../shared/logger';
import { createMutationQueue } from '../../shared/mutationQueue';

const log = createLogger('OverlayVideoTranscode');

// Converts uploaded QuickTime (.mov) overlay videos to WebM. Editors export transparent video as
// MOV (ProRes 4444, QuickTime Animation, PNG-in-MOV), which browsers — and so OBS's browser
// source — can't play. VP9 WebM with an alpha channel is what the overlay page can play with
// transparency intact.

/** Kills ffmpeg and rejects if one conversion hasn't finished within this long. */
export const WEBM_TRANSCODE_TIMEOUT_MS = 5 * 60_000;

/**
 * After a timeout kills ffmpeg, waits at most this long for it to exit before giving up its
 * queue slot anyway, so a child that never reports `close` can't hold the queue forever.
 */
export const KILLED_FFMPEG_EXIT_GRACE_MS = 5_000;

/**
 * Most conversions queued or running at once. Each one holds its upload's buffer and a
 * temporary copy on disk until it finishes, so a burst of uploads is turned away rather than
 * left waiting (and holding both) behind several five-minute conversions.
 */
export const MAX_PENDING_WEBM_TRANSCODES = 3;

/** Keeps at most this many characters of ffmpeg's stderr in a failure's error message. */
const STDERR_TAIL_CHARS = 500;

/**
 * Serialises conversions: VP9 encoding uses every core it can get, and the bot is a single
 * process that also has to keep chat and voice responsive, so uploads convert one at a time.
 */
const transcodeQueue = createMutationQueue<'webm'>();

/** Number of conversions currently queued or running (see {@link MAX_PENDING_WEBM_TRANSCODES}). */
let pendingTranscodes = 0;

/** The ffmpeg process converting right now, if any, so shutdown can stop it. */
let activeProcess: ChildProcess | undefined;

/** Set by {@link stopWebmTranscodes}: once the bot is shutting down, no new conversion starts. */
let stopped = false;

/**
 * True when a new conversion would be turned away as `transcode_busy`. The upload route checks
 * this before buffering a file the client says is a MOV, so a busy server doesn't first take in
 * the whole upload only to refuse it.
 * @returns True when {@link MAX_PENDING_WEBM_TRANSCODES} conversions are queued or running.
 */
export function isWebmTranscodeQueueFull(): boolean {
  return pendingTranscodes >= MAX_PENDING_WEBM_TRANSCODES;
}

/**
 * Stops conversions for shutdown: kills the running ffmpeg, if any, and makes every queued or
 * later conversion reject without starting one. Their temporary files are removed by the
 * caller's failure path or, if the process exits first, by the next upload's stale-file sweep.
 */
export function stopWebmTranscodes(): void {
  stopped = true;
  if (activeProcess) {
    log.info(`Stopping the running overlay video conversion (pid ${activeProcess.pid}) for shutdown`);
    activeProcess.kill('SIGKILL');
  }
}

/**
 * Builds the ffmpeg arguments that convert `inputPath` to a VP9/Opus WebM at `outputPath`.
 * `yuva420p` keeps the alpha channel (an opaque source just gets a fully opaque one), and
 * `-auto-alt-ref 0` is needed because libvpx drops alpha when alt-ref frames are on. Only the
 * first video stream and, if there is one, the first audio stream are kept, and metadata is
 * dropped (`-map_metadata -1` stops both global and per-stream tags being copied) so nothing
 * from the uploader's machine ends up in the served file.
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
 * Builds the error a timed-out conversion rejects with.
 * @returns An Error naming the timeout.
 */
function timeoutError(): Error {
  return new Error(`ffmpeg WebM conversion timed out after ${WEBM_TRANSCODE_TIMEOUT_MS}ms`);
}

/**
 * Builds the error a conversion rejects with when ffmpeg exits other than cleanly.
 * @param code - ffmpeg's exit code, or null when a signal ended it.
 * @param stderrTail - The last characters ffmpeg wrote to stderr.
 * @returns An Error carrying both.
 */
function exitError(code: number | null, stderrTail: string): Error {
  return new Error(`ffmpeg exited with code ${code}: ${stderrTail}`);
}

/**
 * Runs the bundled ffmpeg with `args`. If it hasn't exited within
 * {@link WEBM_TRANSCODE_TIMEOUT_MS} it's killed, and the promise rejects once it has actually
 * exited (or after {@link KILLED_FFMPEG_EXIT_GRACE_MS}, with a warning that it may still be
 * running), so the caller never removes files or starts the next conversion while it's running.
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
    activeProcess = proc;
    let stderrTail = '';
    let timedOut = false;
    let exitGrace: NodeJS.Timeout | undefined;
    const settle = (err?: Error): void => {
      clearTimeout(timeout);
      clearTimeout(exitGrace);
      if (activeProcess === proc) activeProcess = undefined;
      if (err) reject(err);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      exitGrace = setTimeout(() => {
        log.warn(`ffmpeg (pid ${proc.pid}) had not exited ${KILLED_FFMPEG_EXIT_GRACE_MS}ms after SIGKILL; releasing its conversion slot anyway`);
        settle(timeoutError());
      }, KILLED_FFMPEG_EXIT_GRACE_MS);
    }, WEBM_TRANSCODE_TIMEOUT_MS);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    proc.on('error', (err) => settle(err));
    proc.on('close', (code) => {
      if (timedOut) settle(timeoutError());
      else settle(code === 0 ? undefined : exitError(code, stderrTail));
    });
  });
}

/**
 * Runs one queued conversion, logging how long it took and how it ended.
 * @param inputPath - Absolute path of the uploaded source video.
 * @param outputPath - Absolute path to write the WebM to.
 * @returns Resolves once the WebM has been written.
 * @throws If the bot is shutting down, or ffmpeg fails or times out.
 */
async function runConversion(inputPath: string, outputPath: string): Promise<void> {
  if (stopped) throw new Error('Overlay video conversion stopped for shutdown');
  const started = Date.now();
  log.info(`Converting ${path.basename(inputPath)} to WebM`);
  try {
    await runFfmpeg(buildWebmTranscodeArgs(inputPath, outputPath));
  } catch (err) {
    log.warn(`Converting ${path.basename(inputPath)} to WebM failed after ${Date.now() - started}ms`);
    throw err;
  }
  log.info(`Converted ${path.basename(inputPath)} to WebM in ${Date.now() - started}ms`);
}

/**
 * Converts the video at `inputPath` to a transparent-capable VP9 WebM at `outputPath`, waiting
 * for any conversion already running to finish first. The caller owns both files, including
 * removing a partial `outputPath` if this rejects.
 * @param inputPath - Absolute path of the uploaded source video.
 * @param outputPath - Absolute path to write the WebM to.
 * @returns Resolves once the WebM has been written.
 * @throws With `code: 'transcode_busy'`, without queueing, when
 *   {@link MAX_PENDING_WEBM_TRANSCODES} conversions are already queued or running; otherwise if
 *   the bot is shutting down, or ffmpeg fails or times out.
 */
export async function transcodeToWebm(inputPath: string, outputPath: string): Promise<void> {
  if (isWebmTranscodeQueueFull()) {
    throw Object.assign(new Error('Too many WebM conversions pending'), { code: 'transcode_busy' });
  }
  pendingTranscodes++;
  try {
    await transcodeQueue.run('webm', () => runConversion(inputPath, outputPath));
  } finally {
    pendingTranscodes--;
  }
}
