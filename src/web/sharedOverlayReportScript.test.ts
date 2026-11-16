import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(__dirname, '../../public/shared-overlay-report.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(`${source}\nthis.api = { createReadinessReporter, nextDownloadState };`, context);
const { createReadinessReporter, nextDownloadState } = context.api;

let sends: Array<(status?: number) => void>;
const make = () => createReadinessReporter({
  send: () => new Promise<number | undefined>((resolve) => { sends.push(resolve); }),
  gapMs: 3000,
  retryMs: 15000,
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
});
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  sends = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createReadinessReporter', () => {
  it('sends the first request at once', async () => {
    make().request();
    await flush();
    expect(sends).toHaveLength(1);
  });

  it('keeps one report in flight and folds requests made meanwhile into one later report', async () => {
    const reporter = make();
    reporter.request();
    await flush();
    reporter.request();
    reporter.request();
    await flush();
    expect(sends).toHaveLength(1); // still waiting for the first to finish
    sends[0]!(200);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sends).toHaveLength(2);
    sends[1]!(200);
    await vi.advanceTimersByTimeAsync(10000);
    expect(sends).toHaveLength(2); // the two meanwhile requests cost one report
  });

  it('spaces reports of every trigger by the gap', async () => {
    const reporter = make();
    reporter.request();
    await flush();
    sends[0]!(200);
    await flush();
    reporter.request();
    await vi.advanceTimersByTimeAsync(2999);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toHaveLength(2);
  });

  it('retries the latest state after a 429, later than the normal gap', async () => {
    const reporter = make();
    reporter.request();
    await flush();
    sends[0]!(429);
    await vi.advanceTimersByTimeAsync(14999);
    expect(sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toHaveLength(2);
  });

  it('does not retry other failures', async () => {
    const reporter = make();
    reporter.request();
    await flush();
    sends[0]!(undefined);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sends).toHaveLength(1);
  });

  it('survives a send that throws and still reports later requests', async () => {
    const send = vi.fn(() => Promise.reject(new Error('x')));
    const reporter = createReadinessReporter({
      send, gapMs: 10, retryMs: 20, now: () => Date.now(), setTimer: setTimeout,
    });
    reporter.request();
    await flush();
    reporter.request();
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('nextDownloadState', () => {
  const running = { url: '/a', percent: 40 };

  it('follows progress', () => {
    expect(nextDownloadState(null, { type: 'progress', url: '/a', percent: 10 })).toEqual({ url: '/a', percent: 10 });
  });

  it('clears on idle, and when the downloading video is stored or removed', () => {
    expect(nextDownloadState(running, { type: 'idle' })).toBeNull();
    expect(nextDownloadState(running, { type: 'stored', url: '/a' })).toBeNull();
    expect(nextDownloadState(running, { type: 'removed', url: '/a' })).toBeNull();
  });

  it('keeps the running download when another video is stored or removed', () => {
    expect(nextDownloadState(running, { type: 'removed', url: '/b' })).toBe(running);
    expect(nextDownloadState(running, { type: 'stored', url: '/b' })).toBe(running);
  });

  it('stays empty when nothing was downloading', () => {
    expect(nextDownloadState(null, { type: 'removed', url: '/b' })).toBeNull();
  });
});
