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
  /** True when reads work but writes throw (a full quota). */
  writeThrows?: boolean;
  now?: number;
  /** What the /api/status probe resolves to, or `reject` for an unreachable server. */
  probe?: { status: number; redirected?: boolean } | 'reject';
}

const NOW = 1_000_000;

/** Runs public/dashboard-context.js with a stub window, fetch and timers, and returns its entry point and the stubs. */
function runContext({ stored, now = NOW, probe = { status: 200 }, writeThrows = false }: RunOptions = {}) {
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
      if (stored === 'throw' || writeThrows) throw new Error('blocked');
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

/** Fires the server's frame on a source and runs the settle-delay timer it sets, as the clock reaching it would. */
function frame(src: FakeSource, ctx: { timers: { fn: () => void; ms: number }[] }): void {
  src.fire('context-changed');
  ctx.timers.shift()?.fn();
}

/** Lets the probe's promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let source: FakeSource;
beforeEach(() => { source = new FakeSource(); });

describe('public/dashboard-context.js: the context-changed frame', () => {
  it('closes the stream at once, and reloads once the 1.5 s settle delay has passed', () => {
    const ctx = runContext();
    ctx.watch(source);
    source.fire('context-changed');

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.timers).toHaveLength(1);
    expect(ctx.timers[0]!.ms).toBe(1500);

    ctx.timers[0]!.fn();
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload once the page is navigating away (a Logout click)', () => {
    const ctx = runContext();
    ctx.watch(source);
    ctx.windowListeners.get('beforeunload')?.();
    frame(source, ctx);
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it('does not reload for a navigation that began during the settle delay', () => {
    const ctx = runContext();
    ctx.watch(source);
    source.fire('context-changed');
    ctx.windowListeners.get('beforeunload')?.();
    ctx.timers[0]!.fn();
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it('replays a reload that was dropped while the page was leaving once the page is restored from the back/forward cache', () => {
    const ctx = runContext();
    ctx.watch(source);
    ctx.windowListeners.get('beforeunload')?.();
    frame(source, ctx);
    expect(ctx.reload).not.toHaveBeenCalled();

    ctx.windowListeners.get('pageshow')?.({ persisted: false });
    expect(ctx.reload).not.toHaveBeenCalled();
    ctx.windowListeners.get('pageshow')?.({ persisted: true });
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on a restored page when nothing was asked for while it was leaving', () => {
    const ctx = runContext();
    ctx.watch(source);
    ctx.windowListeners.get('beforeunload')?.();
    ctx.windowListeners.get('pageshow')?.({ persisted: true });
    expect(ctx.reload).not.toHaveBeenCalled();
    frame(source, ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once even when both streams report the change', () => {
    const ctx = runContext();
    const other = new FakeSource();
    ctx.watch(source);
    ctx.watch(other);
    source.fire('context-changed');
    other.fire('context-changed');
    expect(ctx.timers).toHaveLength(1);
    expect(other.close).toHaveBeenCalledTimes(1);
    ctx.timers.shift()?.fn();
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('records the reload time', () => {
    const ctx = runContext();
    ctx.watch(source);
    frame(source, ctx);
    expect(ctx.store.get('dashboardContextReloadAt')).toBe(String(NOW));
  });

  it('holds a frame that arrives within 30 seconds of the last reload until the window ends, instead of losing it', () => {
    const ctx = runContext({ stored: String(NOW - 29_000) });
    ctx.watch(source);
    frame(source, ctx);

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(ctx.timers).toHaveLength(1);
    expect(ctx.timers[0]!.ms).toBe(1000);

    source.fire('context-changed');
    expect(ctx.timers).toHaveLength(1);
  });

  it('reloads when the held-back window ends', () => {
    const ctx = runContext({ stored: String(NOW - 29_000) });
    ctx.watch(source);
    frame(source, ctx);
    ctx.clock.now += 1000;
    ctx.timers[0]!.fn();
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('drops the held-back reload if the page starts navigating meanwhile, and replays it from the back/forward cache', () => {
    const ctx = runContext({ stored: String(NOW - 29_000) });
    ctx.watch(source);
    frame(source, ctx);
    ctx.windowListeners.get('beforeunload')?.();
    ctx.clock.now += 1000;
    ctx.timers[0]!.fn();
    expect(ctx.reload).not.toHaveBeenCalled();
    ctx.windowListeners.get('pageshow')?.({ persisted: true });
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads after the settle delay when 30 seconds have passed since the last reload', () => {
    const ctx = runContext({ stored: String(NOW - 30_000) });
    ctx.watch(source);
    frame(source, ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(ctx.timers).toHaveLength(0);
  });

  it('still reloads for the frame, once per page load, when sessionStorage throws', () => {
    const ctx = runContext({ stored: 'throw' });
    ctx.watch(source);
    frame(source, ctx);
    frame(source, ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads for the frame when storage reads work but writes throw', () => {
    const ctx = runContext({ writeThrows: true });
    ctx.watch(source);
    frame(source, ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a garbage stored value', () => {
    const ctx = runContext({ stored: 'abc' });
    ctx.watch(source);
    frame(source, ctx);
    expect(ctx.reload).toHaveBeenCalledTimes(1);
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

  it('does not reload when storage reads work but the timestamp write throws, as nothing would record the reload', async () => {
    const { watch, reload } = runContext({ probe: { status: 401 }, writeThrows: true });
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
