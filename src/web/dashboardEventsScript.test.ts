import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { waitFor } from '../test-utils/waitFor';

const scriptPath = path.join(__dirname, '../../public/dashboard-events.js');

/** A minimal DOM node: enough of Element for dashboard-events.js. */
class FakeNode {
  className = '';
  textContent = '';
  dateTime = '';
  children: FakeNode[] = [];
  attributes: Record<string, string> = {};
  parent: FakeNode | null = null;

  constructor(public tag: string) {}

  /** Like Element.setAttribute. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  /** Like Node.appendChild. */
  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** Like Node.insertBefore, for the one case the script uses (before the first child). */
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    child.parent = this;
    this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, child);
    return child;
  }

  /** Like Node.removeChild. */
  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }

  /** Like Element.remove. */
  remove(): void {
    this.parent?.removeChild(this);
  }

  /** The first child. */
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  /** The last child. */
  get lastChild(): FakeNode | null {
    return this.children[this.children.length - 1] ?? null;
  }

  /** Supports only `.empty-msg`, the one selector the script uses. */
  querySelector(selector: string): FakeNode | null {
    return selector === '.empty-msg' ? this.children.find((c) => c.className === 'empty-msg') ?? null : null;
  }

  /** All text under this node, in order. */
  get allText(): string {
    return this.textContent + this.children.map((c) => c.allText).join('');
  }
}

/** A fake EventSource that records instances so a test can push messages. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  listeners = new Map<string, (() => void)[]>();

  addEventListener(name: string, fn: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
}

interface RunOptions {
  initialEvents?: unknown[];
  hasStreamer?: boolean;
  fetchEvents?: unknown[];
  /** Replaces the default fetch (which answers at once with `fetchEvents`), for tests that answer by hand. */
  fetchImpl?: () => Promise<unknown>;
}

/** Runs public/dashboard-events.js in a fresh context with a stub DOM, EventSource and fetch. */
function runEvents({ initialEvents, hasStreamer = true, fetchEvents = [], fetchImpl }: RunOptions = {}) {
  FakeEventSource.instances = [];
  const list = new FakeNode('div');
  const empty = new FakeNode('p');
  empty.className = 'empty-msg';
  empty.textContent = 'No recent activity yet.';
  list.appendChild(empty);
  const dataset: Record<string, string> = { hasStreamer: String(hasStreamer) };
  if (initialEvents) dataset.initialEvents = JSON.stringify(initialEvents);
  const watchStreamContext = vi.fn();
  const fetch = vi.fn(fetchImpl ?? (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, events: fetchEvents }) })));
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === 'recent-events-list' ? list : null),
      createElement: (tag: string) => new FakeNode(tag),
      body: { dataset },
    },
    EventSource: FakeEventSource,
    fetch,
    watchStreamContext,
    // The real helpers live in dashboard-utils.js, loaded before this script.
    relativeTime: (iso: string) => (iso ? `ago:${iso}` : '—'),
    clearChildren: (el: FakeNode) => {
      el.children = [];
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context);
  return { list, fetch, watchStreamContext, source: FakeEventSource.instances[0] };
}

/** The child of a fake node at `index`; throws a descriptive error when it is missing, so a test fails with a clear message. */
function childAt(node: FakeNode, index: number): FakeNode {
  const child = node.children[index];
  if (!child) throw new Error(`no fake child at index ${index} (the node has ${node.children.length})`);
  return child;
}

/** A hand-answered fetch: each call waits for the test to resolve it with a snapshot (or a failure). */
function manualFetch() {
  const pending: { resolve: (events: unknown[]) => void; fail: () => void }[] = [];
  const impl = () => new Promise((resolve, reject) => {
    pending.push({
      resolve: (events) => resolve({ ok: true, json: () => Promise.resolve({ ok: true, events }) }),
      fail: () => reject(new Error('offline')),
    });
  });
  return { impl, pending };
}

const ev = (eventType: string, detail: string | null = null) => ({
  eventType, displayName: 'viewer_one', detail, occurredAt: '2026-11-20T10:00:00.000Z',
});

describe('public/dashboard-events.js rows', () => {
  it.each([
    ['follow', '💜', 'Follow', 'viewer_one followed'],
    ['sub', '🌟', 'Subscription', 'viewer_one subscribed'],
    ['resub', '🔁', 'Resubscription', 'viewer_one resubscribed'],
    ['giftsub', '🎁', 'Gift sub', 'viewer_one gifted a sub'],
    ['raid', '🚀', 'Raid', 'viewer_one raided'],
    ['redemption', '🪙', 'Channel point redemption', 'viewer_one redeemed'],
    ['raffle_payout_failed', '⚠️', 'Raffle', 'viewer_one won a raffle'],
  ])('renders one hidden-from-AT icon, a source label, the description and a time for %s', (type, icon, label, text) => {
    const { list } = runEvents({ initialEvents: [ev(type)] });
    const item = list.children[0]!;
    expect(item.className).toBe('event-item');
    const [iconEl, body] = item.children;
    expect(item.children).toHaveLength(2);
    expect(iconEl!.className).toBe('event-icon');
    expect(iconEl!.textContent).toBe(icon);
    expect(iconEl!.attributes['aria-hidden']).toBe('true');
    const [source, description] = body!.children[0]!.children;
    expect(source!.className).toBe('visually-hidden');
    expect(source!.textContent).toBe(`${label}: `);
    expect(description!.textContent).toBe(text);
    const time = body!.children[1]!.children[0]!;
    expect(time.tag).toBe('time');
    expect(time.dateTime).toBe('2026-11-20T10:00:00.000Z');
    expect(time.textContent).toBe('ago:2026-11-20T10:00:00.000Z');
  });

  it('appends a detail after the description', () => {
    const { list } = runEvents({ initialEvents: [ev('redemption', 'Hydrate')] });
    expect(childAt(list, 0).allText).toContain('viewer_one redeemed — Hydrate');
  });

  it('falls back to a bullet and the raw type for an unknown event type', () => {
    const { list } = runEvents({ initialEvents: [ev('mystery')] });
    const item = list.children[0]!;
    expect(item.children[0]!.textContent).toBe('•');
    expect(item.allText).toContain('mystery: ');
  });
});

describe('public/dashboard-events.js feed behaviour', () => {
  it('keeps the server-rendered placeholder when there are no initial events', () => {
    const { list } = runEvents({ initialEvents: [] });
    expect(list.children).toHaveLength(1);
    expect(childAt(list, 0).className).toBe('empty-msg');
  });

  it('hands its stream to the context watcher, and opens none for a viewer with no streamer', () => {
    const { source, watchStreamContext } = runEvents({ hasStreamer: true });
    expect(watchStreamContext).toHaveBeenCalledWith(source);
    expect(runEvents({ hasStreamer: false }).watchStreamContext).not.toHaveBeenCalled();
  });

  it('opens the live stream only for a monitored streamer', () => {
    expect(runEvents({ hasStreamer: true }).source?.url).toBe('/dashboard/events');
    expect(runEvents({ hasStreamer: false }).source).toBeUndefined();
  });

  it('prepends a live event, removing the placeholder, and keeps at most 20 rows', () => {
    const { list, source } = runEvents();
    source!.onmessage!({ data: JSON.stringify(ev('follow')) });
    expect(list.querySelector('.empty-msg')).toBeNull();
    for (let i = 0; i < 25; i++) source!.onmessage!({ data: JSON.stringify({ ...ev('raid'), displayName: `raider_${i}` }) });
    expect(list.children).toHaveLength(20);
    expect(childAt(list, 0).allText).toContain('raider_24 raided');
  });

  it('ignores a malformed live payload', () => {
    const { list, source } = runEvents();
    source!.onmessage!({ data: 'not json' });
    expect(childAt(list, 0).className).toBe('empty-msg');
  });

  it('resyncs the feed from /dashboard/events/recent once the stream has reconnected', async () => {
    const { list, source, fetch } = runEvents({ fetchEvents: [ev('sub')] });
    source!.onerror!();
    source!.onopen!();
    await waitFor(() => expect(list.children[0]?.className).toBe('event-item'));
    expect(fetch).toHaveBeenCalledWith('/dashboard/events/recent');
  });
});

describe('public/dashboard-events.js resync (#1139)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const live = (name: string) => JSON.stringify({ ...ev('follow'), displayName: name });

  it('does not fetch while the stream is down, however many errors fire', async () => {
    const { source, fetch } = runEvents();
    source!.onerror!();
    source!.onerror!();
    source!.onerror!();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches exactly once for an error burst followed by one open', async () => {
    const { source, fetch } = runEvents({ fetchEvents: [ev('sub')] });
    source!.onerror!();
    source!.onerror!();
    source!.onopen!();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch on the first open, with no preceding error', async () => {
    const { source, fetch } = runEvents();
    source!.onopen!();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resyncs once at once when the browser has closed the stream for good', async () => {
    const { source, fetch } = runEvents({ fetchEvents: [ev('sub')] });
    source!.readyState = 2;
    source!.onerror!();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a live event that arrived while the snapshot was in flight, and shows the follow-up snapshot', async () => {
    const { impl, pending } = manualFetch();
    const { list, source } = runEvents({ fetchImpl: impl });
    source!.onerror!();
    source!.onopen!();
    source!.onmessage!({ data: live('live_one') });
    pending[0]!.resolve([ev('sub')]);
    await flush();
    // The stale snapshot isn't rendered over the live event; the feed still shows it.
    expect(childAt(list, 0).allText).toContain('live_one');
    expect(pending).toHaveLength(2);
    pending[1]!.resolve([{ ...ev('follow'), displayName: 'live_one' }, ev('sub')]);
    await flush();
    expect(list.children).toHaveLength(2);
    expect(childAt(list, 0).allText).toContain('live_one');
  });

  it('prepends an event that arrives after the snapshot was applied as usual', async () => {
    const { list, source } = runEvents({ fetchEvents: [ev('sub')] });
    source!.onerror!();
    source!.onopen!();
    await waitFor(() => expect(list.children[0]?.className).toBe('event-item'));
    source!.onmessage!({ data: live('late_one') });
    expect(list.children).toHaveLength(2);
    expect(childAt(list, 0).allText).toContain('late_one');
  });

  it('queues one more run for errors-then-opens during an in-flight resync, not one each', async () => {
    const { impl, pending } = manualFetch();
    const { source } = runEvents({ fetchImpl: impl });
    source!.onerror!();
    source!.onopen!();
    for (let i = 0; i < 3; i++) {
      source!.onerror!();
      source!.onopen!();
    }
    await flush();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve([ev('sub')]);
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve([ev('raid')]);
    await flush();
    expect(pending).toHaveLength(2);
  });

  it('never lets an older snapshot overwrite a newer one', async () => {
    const { impl, pending } = manualFetch();
    const { list, source } = runEvents({ fetchImpl: impl });
    source!.onerror!();
    source!.onopen!();
    source!.onerror!();
    source!.onopen!();
    await flush();
    // Only one request is in flight, so there is no older answer that can land after a newer one.
    expect(pending).toHaveLength(1);
    pending[0]!.resolve([{ ...ev('sub'), displayName: 'first_snapshot' }]);
    await flush();
    pending[1]!.resolve([{ ...ev('sub'), displayName: 'second_snapshot' }]);
    await flush();
    expect(childAt(list, 0).allText).toContain('second_snapshot');
  });

  it('stops re-fetching after the attempt cap, leaving the live-built feed', async () => {
    const { impl, pending } = manualFetch();
    const { list, source } = runEvents({ fetchImpl: impl });
    source!.onerror!();
    source!.onopen!();
    for (let i = 0; i < 3; i++) {
      source!.onmessage!({ data: live(`burst_${i}`) });
      pending[i]!.resolve([ev('sub')]);
      await flush();
    }
    expect(pending).toHaveLength(3);
    expect(childAt(list, 0).allText).toContain('burst_2');
    expect(list.allText).not.toContain('viewer_one subscribed');
  });

  it('leaves the feed alone for a failed or non-OK fetch', async () => {
    const { impl, pending } = manualFetch();
    const { list, source } = runEvents({ fetchImpl: impl });
    source!.onerror!();
    source!.onopen!();
    pending[0]!.fail();
    await flush();
    expect(childAt(list, 0).className).toBe('empty-msg');
  });

  it('shows the empty message when the snapshot is empty', async () => {
    const { list, source } = runEvents({ fetchEvents: [] });
    source!.onmessage!({ data: live('live_one') });
    expect(childAt(list, 0).className).toBe('event-item');
    source!.onerror!();
    source!.onopen!();
    await waitFor(() => expect(childAt(list, 0).className).toBe('empty-msg'));
  });
});
