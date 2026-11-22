import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/app.js');

/** A fake EventSource: records the URL and exposes the handlers app.js assigns. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  listeners = new Map<string, (() => void)[]>();

  addEventListener(name: string, fn: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  constructor(public url: string) {
    FakeEventSource.last = this;
  }
}

/**
 * Runs public/app.js with stubs for the functions it calls from the other dashboard scripts.
 * `stale` is what isStatusFeedStale() answers.
 */
function runApp(options: { initialStatus?: string; stale?: boolean } = {}) {
  const calls: string[] = [];
  const stub = (name: string) => vi.fn((...args: unknown[]) => calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`));
  const context: Record<string, unknown> = {
    document: { body: { dataset: { initialStatus: options.initialStatus, csrfToken: 'tok' } } },
    EventSource: FakeEventSource,
    setInterval: vi.fn(),
    applyStatus: stub('applyStatus'),
    fetchStatus: stub('fetchStatus'),
    loadVoiceChannels: stub('loadVoiceChannels'),
    setStatusStreamOpen: stub('setStatusStreamOpen'),
    isStatusFeedStale: () => options.stale ?? false,
    watchStreamContext: vi.fn(),
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  const source = FakeEventSource.last;
  if (!source) throw new Error('app.js opened no EventSource');
  calls.length = 0;
  return { source, calls, context };
}

describe('public/app.js status stream wiring', () => {
  it('hands its stream to the context watcher, so a context change reloads the page', () => {
    const { source, context } = runApp();

    expect(context.watchStreamContext).toHaveBeenCalledTimes(1);
    expect(context.watchStreamContext).toHaveBeenCalledWith(source);
  });

  it('opens the status stream and keeps the 60s safety-net poll', () => {
    const { source, context } = runApp();

    expect(source.url).toBe('/dashboard/status/events');
    expect(context.setInterval).toHaveBeenCalledWith(context.fetchStatus, 60_000);
  });

  it('marks the stream up on open, without refetching while the dashboard is current', () => {
    const { source, calls } = runApp({ stale: false });
    source.onopen?.();

    expect(calls).toEqual(['setStatusStreamOpen(true)']);
  });

  it('refetches on open after an outage, because the stream sends no snapshot on connect', () => {
    const { source, calls } = runApp({ stale: true });
    source.onopen?.();

    expect(calls).toEqual(['setStatusStreamOpen(true)', 'fetchStatus()']);
  });

  it('marks the stream up and applies each message', () => {
    const { source, calls } = runApp();
    source.onmessage?.({ data: '{"discord":{"ready":true}}' });

    expect(calls).toEqual(['setStatusStreamOpen(true)', 'applyStatus({"discord":{"ready":true}})']);
  });

  it('ignores a malformed message', () => {
    const { source, calls } = runApp();
    source.onmessage?.({ data: 'not json' });

    expect(calls).toEqual(['setStatusStreamOpen(true)']);
  });

  it('marks the stream down on error, then falls back to a fetch', () => {
    const { source, calls } = runApp();
    source.onerror?.();

    expect(calls).toEqual(['setStatusStreamOpen(false)', 'fetchStatus()']);
  });

  it('applies the server-rendered initial status', () => {
    const calls: string[] = [];
    const context: Record<string, unknown> = {
      document: { body: { dataset: { initialStatus: '{"discord":{"ready":false}}' } } },
      EventSource: FakeEventSource,
      setInterval: vi.fn(),
      applyStatus: (s: unknown) => calls.push(`applyStatus(${JSON.stringify(s)})`),
      fetchStatus: () => calls.push('fetchStatus()'),
      loadVoiceChannels: () => calls.push('loadVoiceChannels()'),
      setStatusStreamOpen: () => {},
      isStatusFeedStale: () => false,
      watchStreamContext: vi.fn(),
    };
    vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);

    expect(calls.slice(0, 2)).toEqual(['applyStatus({"discord":{"ready":false}})', 'loadVoiceChannels()']);
  });
});
