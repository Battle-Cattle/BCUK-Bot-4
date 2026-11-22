import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/dashboard-context.js');

type Listener = () => void;

/** A fake EventSource: records listeners by event name and lets a test fire them. */
class FakeSource {
  listeners = new Map<string, Listener[]>();
  readyState = 0;

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
}

/** Runs public/dashboard-context.js with a stub window, and returns its entry point and the stubs. */
function runContext({ stored, now = 1_000_000 }: RunOptions = {}) {
  const store = new Map<string, string>();
  if (stored && stored !== 'throw') store.set('dashboardContextReloadAt', stored);
  const reload = vi.fn();
  const windowListeners = new Map<string, Listener>();
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
    Date: { now: () => now },
  };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(scriptPath, 'utf8')}\nthis.watchStreamContext = watchStreamContext;`, context);
  const watch = context.watchStreamContext as (source: FakeSource) => void;
  return { watch, reload, store, windowListeners };
}

let source: FakeSource;
beforeEach(() => { source = new FakeSource(); });

describe('public/dashboard-context.js', () => {
  it('reloads when the server sends the context-changed frame', () => {
    const { watch, reload } = runContext();
    watch(source);
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the browser has given up on the stream (a stale cookie got the login page as HTML)', () => {
    const { watch, reload } = runContext();
    watch(source);
    source.readyState = 2;
    source.fire('error');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload on an error while the stream is still reconnecting (a post-attach failure)', () => {
    const { watch, reload } = runContext();
    watch(source);
    source.readyState = 0;
    source.fire('error');
    source.readyState = 1;
    source.fire('error');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload once the page is navigating away (a Logout click)', () => {
    const { watch, reload, windowListeners } = runContext();
    watch(source);
    windowListeners.get('beforeunload')?.();
    source.fire('context-changed');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once even when both streams report the change', () => {
    const { watch, reload } = runContext();
    const other = new FakeSource();
    watch(source);
    watch(other);
    source.fire('context-changed');
    other.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('records the reload time, and skips a reload within 30 seconds of the last one', () => {
    const { watch, reload, store } = runContext();
    watch(source);
    source.fire('context-changed');
    expect(store.get('dashboardContextReloadAt')).toBe('1000000');

    const recent = runContext({ stored: String(1_000_000 - 29_000) });
    recent.watch(source);
    source.fire('context-changed');
    expect(recent.reload).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once 30 seconds have passed since the last reload', () => {
    const { watch, reload } = runContext({ stored: String(1_000_000 - 30_000) });
    watch(source);
    source.fire('context-changed');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads, once per page load, when sessionStorage throws', () => {
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
