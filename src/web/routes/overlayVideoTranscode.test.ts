import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import { spawn } from 'child_process';
import { waitFor } from '../../test-utils/waitFor';
import {
  buildWebmTranscodeArgs, transcodeToWebm, isWebmTranscodeQueueFull,
  WEBM_TRANSCODE_TIMEOUT_MS, KILLED_FFMPEG_EXIT_GRACE_MS, MAX_PENDING_WEBM_TRANSCODES,
} from './overlayVideoTranscode';

/** Fake ChildProcess-like EventEmitter for mocking `spawn`. */
function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stderr = new EventEmitter();
  proc.stderr.setEncoding = vi.fn();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = vi.fn();
  proc.kill = vi.fn();
  return proc;
}

/** Resolves once `spawn` has been called `count` times (transcodes start after a queue hop). */
async function spawnCalled(count = 1) {
  await waitFor(() => expect(vi.mocked(spawn).mock.calls.length).toBeGreaterThanOrEqual(count));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildWebmTranscodeArgs', () => {
  it('reads the input and writes a VP9 WebM to the output', () => {
    const args = buildWebmTranscodeArgs('/in.mov.upload', '/out.webm');
    expect(args[args.indexOf('-i') + 1]).toBe('/in.mov.upload');
    expect(args.at(-1)).toBe('/out.webm');
    expect(args[args.indexOf('-f') + 1]).toBe('webm');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
    expect(args[args.indexOf('-c:a') + 1]).toBe('libopus');
  });

  it('keeps the alpha channel', () => {
    const args = buildWebmTranscodeArgs('/in', '/out');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuva420p');
    // libvpx drops alpha when alt-ref frames are enabled.
    expect(args[args.indexOf('-auto-alt-ref') + 1]).toBe('0');
  });

  it('keeps the first video stream, an optional audio stream and no metadata', () => {
    const args = buildWebmTranscodeArgs('/in', '/out');
    const mapped = args.flatMap((arg, i) => (arg === '-map' ? [args[i + 1]] : []));
    expect(mapped).toEqual(['0:v:0', '0:a:0?']);
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
    expect(args).toContain('-nostdin');
  });
});

describe('buildWebmTranscodeArgs progress reporting', () => {
  it('has ffmpeg print the source length and write its progress to stdout', () => {
    const args = buildWebmTranscodeArgs('/in', '/out');
    expect(args[args.indexOf('-loglevel') + 1]).toBe('info');
    expect(args[args.indexOf('-progress') + 1]).toBe('pipe:1');
    expect(args).toContain('-nostats');
  });
});

describe('transcodeToWebm progress', () => {
  it('reports queued, then converting, then the rising percentage', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const onProgress = vi.fn();
    const promise = transcodeToWebm('/in', '/out', onProgress);
    expect(onProgress).toHaveBeenNthCalledWith(1, { stage: 'queued', percent: null });
    await spawnCalled();
    expect(vi.mocked(spawn).mock.calls[0]![2]).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(onProgress).toHaveBeenNthCalledWith(2, { stage: 'converting', percent: null });
    proc.stderr.emit('data', '  Duration: 00:00:10.00, start: 0.000000\n');
    proc.stdout.emit('data', 'out_time_us=2500000\nprogress=continue\n');
    proc.stdout.emit('data', 'out_time_us=5000000\n');
    proc.emit('close', 0);
    await promise;
    expect(onProgress.mock.calls.slice(2)).toEqual([
      [{ stage: 'converting', percent: 25 }],
      [{ stage: 'converting', percent: 50 }],
    ]);
  });

  it('works without a progress listener', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToWebm('/in', '/out');
    await spawnCalled();
    proc.stderr.emit('data', '  Duration: 00:00:10.00, start: 0.000000\n');
    proc.stdout.emit('data', 'out_time_us=5000000\n');
    proc.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('transcodeToWebm', () => {
  it('runs ffmpeg with the built arguments and resolves on a clean exit', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToWebm('/in.mov.upload', '/out.webm');
    await spawnCalled();
    expect(spawn).toHaveBeenCalledWith('/usr/bin/ffmpeg', buildWebmTranscodeArgs('/in.mov.upload', '/out.webm'), expect.any(Object));
    proc.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with the end of stderr on a non-zero exit code', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToWebm('/in', '/out');
    await spawnCalled();
    proc.stderr.emit('data', 'x'.repeat(1000));
    proc.stderr.emit('data', 'moov atom not found');
    proc.emit('close', 1);
    const error = await promise.then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toMatch(/^ffmpeg exited with code 1: x+moov atom not found$/);
    expect(error?.message.length).toBeLessThan(600);
  });

  it('rejects when ffmpeg cannot be started', async () => {
    const proc = makeFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    const promise = transcodeToWebm('/in', '/out');
    await spawnCalled();
    proc.emit('error', new Error('spawn ENOENT'));
    await expect(promise).rejects.toThrow('spawn ENOENT');
  });

  it('kills ffmpeg on timeout and rejects only once it has exited', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(proc);
      let settled = false;
      const promise = transcodeToWebm('/in', '/out');
      void promise.catch(() => {}).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(WEBM_TRANSCODE_TIMEOUT_MS);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(false);
      proc.emit('close', null);
      await expect(promise).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up waiting for a killed ffmpeg to exit after the grace period', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = transcodeToWebm('/in', '/out');
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(WEBM_TRANSCODE_TIMEOUT_MS + KILLED_FFMPEG_EXIT_GRACE_MS);
      await assertion;
      // A late exit after the slot was released changes nothing.
      expect(() => proc.emit('close', null)).not.toThrow();
      await expect(promise).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a conversion away without queueing it when too many are already pending', async () => {
    const procs = Array.from({ length: MAX_PENDING_WEBM_TRANSCODES }, () => makeFakeProcess());
    for (const proc of procs) vi.mocked(spawn).mockReturnValueOnce(proc);
    expect(isWebmTranscodeQueueFull()).toBe(false);
    const pending = procs.map((_, i) => transcodeToWebm(`/in${i}`, `/out${i}`));
    expect(isWebmTranscodeQueueFull()).toBe(true);
    await expect(transcodeToWebm('/extra', '/extra.webm')).rejects.toMatchObject({ code: 'transcode_busy' });
    // Finishing one frees a slot for the next upload.
    await spawnCalled(1);
    procs[0].emit('close', 0);
    await pending[0];
    const next = makeFakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(next);
    const accepted = transcodeToWebm('/next', '/next.webm');
    for (let i = 1; i < procs.length; i++) {
      await spawnCalled(i + 1);
      procs[i].emit('close', 0);
      await pending[i];
    }
    await spawnCalled(procs.length + 1);
    next.emit('close', 0);
    await expect(accepted).resolves.toBeUndefined();
  });

  it('runs one conversion at a time, starting the next once the previous finishes or fails', async () => {
    const first = makeFakeProcess();
    const second = makeFakeProcess();
    vi.mocked(spawn).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const firstPromise = transcodeToWebm('/a', '/a.webm');
    const secondPromise = transcodeToWebm('/b', '/b.webm');
    await spawnCalled(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawn).toHaveBeenCalledOnce();
    first.emit('close', 1);
    await expect(firstPromise).rejects.toThrow(/code 1/);
    await spawnCalled(2);
    second.emit('close', 0);
    await expect(secondPromise).resolves.toBeUndefined();
  });
});

describe('transcodeToWebm without an ffmpeg binary', () => {
  it('rejects without spawning when ffmpeg-static has no binary for this platform', async () => {
    vi.resetModules();
    vi.doMock('ffmpeg-static', () => ({ default: null }));
    try {
      const { transcodeToWebm: transcodeWithoutFfmpeg } = await import('./overlayVideoTranscode.js');
      await expect(transcodeWithoutFfmpeg('/in', '/out')).rejects.toThrow('ffmpeg-static returned no path');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('ffmpeg-static');
    }
  });
});

describe('stopWebmTranscodes', () => {
  /** Imports a fresh copy of the module, so its stopped state doesn't leak into other tests. */
  async function freshModule() {
    vi.resetModules();
    return import('./overlayVideoTranscode.js');
  }

  it('kills the running ffmpeg and starts no queued or later conversion', async () => {
    const mod = await freshModule();
    const proc = makeFakeProcess();
    proc.kill = vi.fn(() => { proc.emit('close', null); return true; });
    vi.mocked(spawn).mockReturnValue(proc);
    const running = mod.transcodeToWebm('/a', '/a.webm');
    const queued = mod.transcodeToWebm('/b', '/b.webm');
    await spawnCalled(1);

    mod.stopWebmTranscodes();

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(running).rejects.toThrow(/code null/);
    await expect(queued).rejects.toThrow(/stopped for shutdown/);
    await expect(mod.transcodeToWebm('/c', '/c.webm')).rejects.toThrow(/stopped for shutdown/);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('does nothing but block later conversions when none is running', async () => {
    const mod = await freshModule();
    mod.stopWebmTranscodes();
    await expect(mod.transcodeToWebm('/a', '/a.webm')).rejects.toThrow(/stopped for shutdown/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
