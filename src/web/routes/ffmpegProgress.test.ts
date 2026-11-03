import { describe, it, expect, vi } from 'vitest';
import { parseDurationSeconds, parseOutTimeSeconds, createFfmpegProgressTracker } from './ffmpegProgress';

const BANNER = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mov.upload':\n  Duration: 00:00:20.00, start: 0.000000, bitrate: 1000 kb/s\n";

describe('parseDurationSeconds', () => {
  it('reads hours, minutes and fractional seconds', () => {
    expect(parseDurationSeconds('  Duration: 01:02:03.50, start: 0')).toBe(3723.5);
  });

  it('returns null before the Duration line arrives, or for N/A or zero', () => {
    expect(parseDurationSeconds("Input #0, mov, from 'x':")).toBeNull();
    expect(parseDurationSeconds('Duration: N/A, start: 0')).toBeNull();
    expect(parseDurationSeconds('Duration: 00:00:00.00, start: 0')).toBeNull();
  });
});

describe('parseOutTimeSeconds', () => {
  it('reads out_time_us in seconds', () => {
    expect(parseOutTimeSeconds('out_time_us=2500000')).toBe(2.5);
    expect(parseOutTimeSeconds('out_time_us=2500000\r')).toBe(2.5);
  });

  it('ignores other progress lines and N/A', () => {
    expect(parseOutTimeSeconds('out_time=00:00:02.500000')).toBeNull();
    expect(parseOutTimeSeconds('out_time_us=N/A')).toBeNull();
    expect(parseOutTimeSeconds('progress=continue')).toBeNull();
  });
});

describe('createFfmpegProgressTracker', () => {
  it('reports the percentage of the source encoded so far', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStderr(BANNER);
    tracker.onStdout('frame=10\nout_time_us=5000000\nprogress=continue\n');
    tracker.onStdout('out_time_us=10000000\n');
    expect(onPercent.mock.calls).toEqual([[25], [50]]);
  });

  it('reports nothing until the source length is known', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStdout('out_time_us=5000000\n');
    expect(onPercent).not.toHaveBeenCalled();
    tracker.onStderr(BANNER);
    tracker.onStdout('out_time_us=6000000\n');
    expect(onPercent).toHaveBeenCalledWith(30);
  });

  it('finds a Duration line split across stderr chunks', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStderr(BANNER.slice(0, 70));
    tracker.onStderr(BANNER.slice(70));
    tracker.onStdout('out_time_us=2000000\n');
    expect(onPercent).toHaveBeenCalledWith(10);
  });

  it('joins a progress line split across stdout chunks', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStderr(BANNER);
    tracker.onStdout('out_time_us=150');
    expect(onPercent).not.toHaveBeenCalled();
    tracker.onStdout('00000\n');
    expect(onPercent).toHaveBeenCalledWith(75);
  });

  it('never reports 100 or more, and never repeats or goes backwards', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStderr(BANNER);
    tracker.onStdout('out_time_us=10000000\nout_time_us=10000000\nout_time_us=8000000\nout_time_us=25000000\n');
    expect(onPercent.mock.calls).toEqual([[50], [99]]);
  });

  it('stops looking for a Duration line after a bounded amount of stderr', () => {
    const onPercent = vi.fn();
    const tracker = createFfmpegProgressTracker(onPercent);
    tracker.onStderr('x'.repeat(20_000));
    tracker.onStderr(BANNER);
    tracker.onStdout('out_time_us=5000000\n');
    expect(onPercent).not.toHaveBeenCalled();
  });
});
