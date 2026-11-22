import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/dashboard-context.js');

type Listener = (event?: { persisted?: boolean }) => void;

/** A fake EventSource: records listeners by event name, lets a test fire them, and notes `close()`. */
class FakeSource {
  listeners = new Map<string, Listener[]>();
  readyState = 0;
  close = vi.fn();

  addEventListener(name: string, fn: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  fire(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
}

interface RunOptions {
  /** What sessionStorage holds for the reload key, or `throw` for storage that throws. */
  stored?: string | 'throw';
  now?: number;
  /** What the /api/status probe resolves to, or `reject` for an unreachable server. */
  probe?: { status: number; redirected?: boolean } | 'reject';
}

const NOW = 1_000_000;

/** Runs public/dashboard-context.js with a stub window, fetch and timers, and returns its entry point and the stubs. */
function runContext({ stored, now = NOW, probe = { status: 200 } }: RunOptions = {}) {
  const store = new Map<string, string>();
  if (stored && stored !== 'throw') store.set('dashboardContextReloadAt', stored);
  const clock = { now };
  const reload = vi.fn();
  const windowListeners = new Map<string, Listener>();
  const timers: { fn: () => void; ms: number }[] = [];
  const fetch = vi.fn(() => (probe === 'reject' ? Promise.reject(new Error('down')) : Promise.resolve({ redirected: false, ...probe })));
  const sessionStorage = {
    getItem: (k: string) => {
      if (stored === 'throw') throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (stored === 'throw') throw new Error('blocked');
      store.set(k, v);
    },
  };
  const context: Record<string, unknown> = {
    window: {
      location: { reload },
      sessionStorage,
      addEventListener: (name: string, fn: Listener) => { windowListeners.set(name, fn); },
    },
    fetch,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    Date: { now: () => clock.now },
  };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(scriptPath, 'utf8')}\nthis.watchStreamContext = watchStreamContext;`, context);
  const watch = context.watchStreamContext as (source: FakeSource) => void;
  return { watch, reload, store, windowListeners, fetch, timers, clock };
}

/** Lets the probe's promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let source: FakeSource;
beforeEach(() => { source = new FakeSource(); });

describe('public/dashboard-context.js: the context-changed frame', () => {
  it('closes the stream and reloads when the server sends the frame', () => {
    const { watch, reload } = runContext();
    watch(source);
    source.fire('context-changed');
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload once the page is navigating away (a Logout click)', () => {
    const { watch, reload, windowListeners } = runContext();
    watch(source);
    windowListeners.get('beforeunload')?.();
    source.fire('context-changed');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again after a page restored from the back/forward cache (pageshow persisted)', () => {
    const { watch, reload, windowListeners } = runContext();
    watch(source);
    windowListeners.get('beforeunload')?.();
    windowListeners.get('pageshow')?.({ persisted: false });
    source.fire('context-changed');
    expect(reload).not.toHaveBeenCalled();
    windowListeners.get('pageshow')?.({ persisted: true });
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once even when both streams report the change', () => {
    const { watch, reload } = runContext();
    const other = new FakeSource();
    watch(source);
    watch(other);
    source.fire('context-changed');
    other.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(other.close).toHaveBeenCalledTimes(1);
  });

  it('records the reload time', () => {
    const { watch, store } = runContext();
    watch(source);
    source.fire('context-changed');
    expect(store.get('dashboardContextReloadAt')).toBe(String(NOW));
  });

  it('holds a frame that arrives within 30 seconds of the last reload until the window ends, instead of losing it', () => {
    const { watch, reload, timers } = runContext({ stored: String(NOW - 29_000) });
    watch(source);
    source.fire('context-changed');

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1000);

    source.fire('context-changed');
    expect(timers).toHaveLength(1);
  });

  it('reloads when the held-back window ends', () => {
    const { watch, reload, timers, clock } = runContext({ stored: String(NOW - 29_000) });
    watch(source);
    source.fire('context-changed');
    clock.now += 1000;
    timers[0]!.fn();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('drops the held-back reload if the page starts navigating meanwhile', () => {
    const { watch, reload, timers, windowListeners } = runContext({ stored: String(NOW - 29_000) });
    watch(source);
    source.fire('context-changed');
    windowListeners.get('beforeunload')?.();
    timers[0]!.fn();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads at once when 30 seconds have passed since the last reload', () => {
    const { watch, reload, timers } = runContext({ stored: String(NOW - 30_000) });
    watch(source);
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
  });

  it('still reloads for the frame, once per page load, when sessionStorage throws', () => {
    const { watch, reload } = runContext({ stored: 'throw' });
    watch(source);
    source.fire('context-changed');
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a garbage stored value', () => {
    const { watch, reload } = runContext({ stored: 'abc' });
    watch(source);
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('public/dashboard-context.js: a stream the browser gave up on', () => {
  it('reloads when /api/status shows the session is signed out (a redirect to login)', async () => {
    const { watch, reload, fetch } = runContext({ probe: { status: 200, redirected: true } });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(fetch).toHaveBeenCalledWith('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on a 401 from /api/status', async () => {
    const { watch, reload } = runContext({ probe: { status: 401 } });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([[200], [429], [500], [502], [503]])('does not reload when /api/status answers %i in place (a full cap or a restart, not a context change)', async (status) => {
    const { watch, reload } = runContext({ probe: { status } });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the server is unreachable', async () => {
    const { watch, reload } = runContext({ probe: 'reject' });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not even probe on an error while the stream is still reconnecting (a post-attach failure)', async () => {
    const { watch, reload, fetch } = runContext({ probe: { status: 401 } });
    watch(source);
    source.readyState = 0;
    source.fire('error');
    source.readyState = 1;
    source.fire('error');
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload within 30 seconds of the last reload (and does not hold it: nothing asked for it)', async () => {
    const { watch, reload, timers } = runContext({ probe: { status: 401 }, stored: String(NOW - 5000) });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('does not reload when sessionStorage throws, as nothing would limit a loop', async () => {
    const { watch, reload } = runContext({ probe: { status: 401 }, stored: 'throw' });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    await settle();
    expect(reload).not.toHaveBeenCalled();
  });

  it('probes once at a time', async () => {
    const { watch, fetch } = runContext({ probe: { status: 200 } });
    watch(source);
    source.readyState = 2;
    source.fire('error');
    source.fire('error');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
