import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));

import { spawn } from 'child_process';
import { waitFor } from '../../test-utils/waitFor';
import { buildWebmTranscodeArgs, transcodeToWebm, WEBM_TRANSCODE_TIMEOUT_MS } from './overlayVideoTranscode';

/** Fake ChildProcess-like EventEmitter for mocking `spawn`. */
function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stderr = new EventEmitter();
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
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '0:a:0?', '-map_metadata', '-1', '-nostdin']));
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
    proc.stderr.emit('data', Buffer.from('x'.repeat(1000)));
    proc.stderr.emit('data', Buffer.from('moov atom not found'));
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

  it('kills ffmpeg and rejects if it does not finish within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(proc);
      const promise = transcodeToWebm('/in', '/out');
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(WEBM_TRANSCODE_TIMEOUT_MS);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      await assertion;
      proc.emit('close', null);
    } finally {
      vi.useRealTimers();
    }
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
