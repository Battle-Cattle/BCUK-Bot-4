// Turns ffmpeg's output into a conversion percentage. ffmpeg prints the source's length on stderr
// (`Duration: 00:00:20.04, …`) and, with `-progress pipe:1`, how far it has encoded on stdout
// (`out_time_us=10020000` lines), so the percentage is one divided by the other.

/** Most stderr kept while looking for the `Duration:` line, so a source without one can't grow it. */
const MAX_DURATION_SEARCH_CHARS = 16_384;

/**
 * Reads the source length from ffmpeg's stderr banner.
 * @param text - Text ffmpeg has written to stderr so far.
 * @returns The length in seconds, or null when no positive `Duration:` has been printed yet.
 */
export function parseDurationSeconds(text: string): number | null {
  // The trailing comma means the whole timestamp has arrived, not just a chunk ending mid-way.
  const match = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?),/.exec(text);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds > 0 ? seconds : null;
}

/**
 * Reads how far ffmpeg has encoded from one `-progress` line.
 * @param line - One line of ffmpeg's `-progress` output.
 * @returns The encoded position in seconds, or null for any other line (or `N/A`).
 */
export function parseOutTimeSeconds(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line.trim());
  return match ? Number(match[1]) / 1_000_000 : null;
}

/** Feeds ffmpeg's stderr and stdout chunks to {@link createFfmpegProgressTracker}. */
export interface FfmpegProgressTracker {
  /** Takes a chunk of ffmpeg's stderr, looking for the source's length. */
  onStderr(chunk: string): void;
  /** Takes a chunk of ffmpeg's `-progress` output on stdout. */
  onStdout(chunk: string): void;
}

/**
 * Builds a tracker that reports the conversion's whole-number percentage each time it changes.
 * It stays at most 99 until ffmpeg exits, since the last frames are still being written when
 * the encoded position reaches the source's length. Nothing is reported until the source's
 * length is known.
 * @param onPercent - Called with the new percentage (0-99) whenever it changes.
 * @returns The tracker to feed ffmpeg's output to.
 */
export function createFfmpegProgressTracker(onPercent: (percent: number) => void): FfmpegProgressTracker {
  let durationSeconds: number | null = null;
  let stderrSoFar = '';
  let stdoutPartial = '';
  let lastPercent = -1;

  const report = (outSeconds: number): void => {
    if (durationSeconds === null) return;
    const percent = Math.min(99, Math.floor((outSeconds / durationSeconds) * 100));
    if (percent <= lastPercent) return;
    lastPercent = percent;
    onPercent(percent);
  };

  return {
    onStderr(chunk) {
      if (durationSeconds !== null || stderrSoFar.length >= MAX_DURATION_SEARCH_CHARS) return;
      stderrSoFar = (stderrSoFar + chunk).slice(0, MAX_DURATION_SEARCH_CHARS);
      durationSeconds = parseDurationSeconds(stderrSoFar);
    },
    onStdout(chunk) {
      const text = stdoutPartial + chunk;
      const lastNewline = text.lastIndexOf('\n');
      // Keep a trailing partial line for the next chunk.
      stdoutPartial = text.slice(lastNewline + 1);
      for (const line of text.slice(0, Math.max(lastNewline, 0)).split('\n')) {
        const outSeconds = parseOutTimeSeconds(line);
        if (outSeconds !== null) report(outSeconds);
      }
    },
  };
}
