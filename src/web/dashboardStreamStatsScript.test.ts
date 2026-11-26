import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const streamPath = path.join(__dirname, '../../public/dashboard-stream.js');
const statsPath = path.join(__dirname, '../../public/dashboard-stream-stats.js');

/** A minimal element: enough of the DOM for dashboard-stream-stats.js. It has no `innerHTML`, so a write to it shows up as a new property. */
class FakeElement {
  hidden = false;
  textContent = '';
  attributes: Record<string, string> = {};

  /** Like Element.setAttribute. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  /** Like Element.removeAttribute. */
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
}

/** A fake EventSource that records its instances so a test can push messages and errors. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((msg: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
}

const IDS = [
  'stream-stats', 'stream-stats-note',
  ...['viewers', 'uptime', 'category', 'title'].flatMap((n) => [`stream-stat-${n}`, `stream-stat-${n}-value`, `stream-stat-${n}-dd`]),
];

const SERVER_TIME = '2026-11-26T12:00:30.000Z';
const CHECKED_AT = '2026-11-26T12:00:00.000Z';
const STARTED_AT = '2026-11-26T10:36:15.000Z';

/** A full live payload, as GET /dashboard/stream/stats and the stream send it. */
const livePayload = (overrides: Record<string, unknown> = {}) => ({
  ok: true, tracked: true, serverTime: SERVER_TIME, live: true, title: 'Late night run', category: 'Just Chatting',
  viewerCount: 1234, startedAt: STARTED_AT, checkedAt: CHECKED_AT, ...overrides,
});

/** Runs dashboard-stream.js and dashboard-stream-stats.js in a fresh context with a stub DOM, EventSource, timer and clock. */
function runStats({ ownChannel = 'streamer_one' as string | null, machineTime = SERVER_TIME } = {}) {
  FakeEventSource.instances = [];
  const els = new Map(IDS.map((id) => [id, new FakeElement()]));
  // Two clocks, as in a browser: the wall clock (Date) can be stepped; the monotonic clock (performance) only runs forward.
  const clock = { now: Date.parse(machineTime), mono: 1000 };
  const ticks: (() => void)[] = [];
  const watchStreamContext = vi.fn();
  /** The fake element with this id; throws if it isn't defined, so a typo fails here. */
  const el = (id: string): FakeElement => {
    const found = els.get(id);
    if (!found) throw new Error(`no fake element with id "${id}"`);
    return found;
  };
  class FakeDate extends Date {
    /** The test's clock, so uptime and ages are exact. */
    static now(): number {
      return clock.now;
    }
  }
  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => els.get(id) ?? null, body: { dataset: ownChannel ? { ownChannel } : {} } },
    EventSource: FakeEventSource,
    Date: FakeDate,
    performance: { now: () => clock.mono },
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length; },
    watchStreamContext,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(streamPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(statsPath, 'utf8'), context);
  const source = FakeEventSource.instances[0];
  /** The opened stream with its handlers; throws a clear error when the script subscribed to nothing. */
  const subscribed = (): FakeEventSource & { onmessage: NonNullable<FakeEventSource['onmessage']>; onerror: NonNullable<FakeEventSource['onerror']> } => {
    if (!source?.onmessage || !source.onerror) throw new Error('the script did not subscribe to the stream with message and error handlers');
    return source as ReturnType<typeof subscribed>;
  };
  return {
    context, el, watchStreamContext, source, ticks,
    /** Delivers a payload over the stream. */
    send: (payload: unknown) => subscribed().onmessage({ data: JSON.stringify(payload) }),
    /** Delivers raw message text over the stream. */
    sendRaw: (data: string) => subscribed().onmessage({ data }),
    /** Makes the stream error, as when the connection drops. */
    fail: () => subscribed().onerror(),
    /** Moves both clocks on and runs the one-second tick. */
    advance: (ms: number) => { clock.now += ms; clock.mono += ms; for (const tick of ticks) tick(); },
    /** Steps only the wall clock (an NTP correction or a manual change) and runs the tick. */
    stepWallClock: (ms: number) => { clock.now += ms; for (const tick of ticks) tick(); },
    /** The text of a stat row, or null when its row is hidden. */
    row: (name: string): string | null => (el(`stream-stat-${name}`).hidden ? null : el(`stream-stat-${name}-value`).textContent),
    /** The note under the stats, or null when it is hidden. */
    note: (): string | null => (el('stream-stats-note').hidden ? null : el('stream-stats-note').textContent),
    /** Whether the whole stats block is hidden. */
    blockHidden: (): boolean => el('stream-stats').hidden,
  };
}

describe('public/dashboard-stream-stats.js stream', () => {
  it('opens the stats stream for a user with an own channel only, and hands it to the context watcher', () => {
    const { source, watchStreamContext } = runStats();
    expect(source?.url).toBe('/dashboard/stream/events');
    expect(watchStreamContext).toHaveBeenCalledWith(source);
    expect(runStats({ ownChannel: null }).source).toBeUndefined();
  });

  it('shows all four stats for a live channel, with the uptime counted from the server\'s time', () => {
    const s = runStats();
    s.send(livePayload());
    expect(s.blockHidden()).toBe(false);
    expect(s.row('viewers')).toBe('1,234');
    expect(s.row('uptime')).toBe('1:24:15');
    expect(s.row('category')).toBe('Just Chatting');
    expect(s.row('title')).toBe('Late night run');
    expect(s.note()).toBeNull();
    expect(s.el('stream-stat-title-dd').attributes.title).toBe('Late night run');
  });

  it('ticks the uptime on without another payload, and passes 24 hours without wrapping', () => {
    const s = runStats();
    s.send(livePayload());
    s.advance(45_000);
    expect(s.row('uptime')).toBe('1:25:00');
    s.send(livePayload({ startedAt: '2026-11-25T09:00:00.000Z' })); // the payload's own server time (12:00:30) is the new reference
    expect(s.row('uptime')).toBe('27:00:30');
  });

  it('omits a row Twitch gave no usable value for, rather than inventing one', () => {
    const s = runStats();
    s.send(livePayload({ viewerCount: undefined, title: undefined, category: '' }));
    expect({ viewers: s.row('viewers'), category: s.row('category'), title: s.row('title') }).toEqual({ viewers: null, category: null, title: null });
    expect(s.row('uptime')).toBe('1:24:15');
    s.send(livePayload({ viewerCount: -1, startedAt: 'not a date' }));
    expect(s.row('viewers')).toBeNull();
    expect(s.row('uptime')).toBeNull();
    s.send(livePayload({ viewerCount: 1.5 }));
    expect(s.row('viewers')).toBeNull();
    s.send(livePayload({ viewerCount: 0 }));
    expect(s.row('viewers')).toBe('0');
  });

  it.each([
    ['offline', livePayload({ live: false })],
    ['not monitored', { ok: true, tracked: false, serverTime: SERVER_TIME }],
    ['an error answer', { ok: false, error: 'no_channel' }],
  ])('shows nothing for a channel that is %s', (_name, payload) => {
    const s = runStats();
    s.send(livePayload());
    expect(s.blockHidden()).toBe(false);
    s.send(payload);
    expect(s.blockHidden()).toBe(true);
    expect(s.note()).toBeNull();
    for (const name of ['viewers', 'uptime', 'category', 'title']) expect(s.row(name)).toBeNull();
  });

  it('ignores a malformed message and shows nothing before the first payload', () => {
    const s = runStats();
    expect(s.blockHidden()).toBe(false); // the markup starts hidden; the script draws only once it has something
    s.sendRaw('not json');
    s.send(null);
    expect(s.blockHidden()).toBe(true);
  });

  it('writes the title and category as text only', () => {
    const s = runStats();
    s.send(livePayload({ title: '<img src=x onerror=alert(1)>', category: '<b>Bold</b>' }));
    expect(s.row('title')).toBe('<img src=x onerror=alert(1)>');
    expect(s.row('category')).toBe('<b>Bold</b>');
    expect('innerHTML' in s.el('stream-stat-title-value')).toBe(false);
    expect('innerHTML' in s.el('stream-stat-category-value')).toBe(false);
  });
});

describe('public/dashboard-stream-stats.js last known values', () => {
  it('shows stats last checked 3 minutes or more ago as last known with their age, the uptime stopped at the last check', () => {
    const s = runStats({ machineTime: '2026-11-26T12:04:00.000Z' });
    s.send(livePayload({ serverTime: '2026-11-26T12:04:00.000Z' }));
    expect(s.note()).toBe('Last known; stats last checked 4 minutes ago.');
    expect(s.row('uptime')).toBe('1:23:45');
    s.advance(60_000);
    expect(s.row('uptime')).toBe('1:23:45');
    expect(s.note()).toBe('Last known; stats last checked 5 minutes ago.');
  });

  it('is not stale just under 3 minutes, and is at exactly 3', () => {
    const s = runStats({ machineTime: '2026-11-26T12:02:59.000Z' });
    s.send(livePayload({ serverTime: '2026-11-26T12:02:59.000Z' }));
    expect(s.note()).toBeNull();
    s.advance(1000);
    expect(s.note()).toBe('Last known; stats last checked 3 minutes ago.');
  });

  it('goes stale by itself when no payload arrives, as the ticker keeps checking', () => {
    const s = runStats();
    s.send(livePayload());
    expect(s.note()).toBeNull();
    s.advance(5 * 60_000);
    expect(s.note()).toMatch(/^Last known; stats last checked 5 minutes ago\./);
    s.send(livePayload({ serverTime: '2026-11-26T12:05:30.000Z', checkedAt: '2026-11-26T12:05:30.000Z' }));
    expect(s.note()).toBeNull();
  });

  it('keeps the last values, marked last known, when the stream errors, and clears the mark on the next payload', () => {
    const s = runStats();
    s.send(livePayload());
    s.fail();
    expect(s.row('viewers')).toBe('1,234');
    expect(s.note()).toBe('Live updates paused; showing the last known values.');
    s.advance(30_000);
    expect(s.row('uptime')).toBe('1:23:45'); // stopped at the last check, not counting on
    s.send(livePayload({ serverTime: '2026-11-26T12:01:00.000Z', checkedAt: '2026-11-26T12:00:55.000Z' }));
    expect(s.note()).toBeNull();
  });

  it('shows nothing for an error before any payload (there are no values to keep)', () => {
    const s = runStats();
    s.fail();
    expect(s.blockHidden()).toBe(true);
  });

  it('is not moved by the wall clock stepping, backward or forward, between payloads', () => {
    const s = runStats();
    s.send(livePayload());
    s.stepWallClock(-60 * 60_000);
    s.advance(45_000);
    expect(s.row('uptime')).toBe('1:25:00');
    expect(s.note()).toBeNull();
    s.stepWallClock(2 * 60 * 60_000);
    expect(s.row('uptime')).toBe('1:25:00');
    // Five more minutes of real time with no payload: 6m15s since the check, stale on the monotonic clock whatever the wall clock did.
    s.advance(5 * 60_000);
    expect(s.note()).toBe('Last known; stats last checked 6 minutes ago.');
  });

  it('works from the server\'s clock: a machine clock an hour ahead changes neither the uptime nor the staleness', () => {
    const s = runStats({ machineTime: '2026-11-26T13:00:30.000Z' });
    s.send(livePayload());
    expect(s.row('uptime')).toBe('1:24:15');
    expect(s.note()).toBeNull();
    s.advance(10_000);
    expect(s.row('uptime')).toBe('1:24:25');
  });
});

describe('public/dashboard-stream-stats.js deriveStreamStats', () => {
  const { context } = runStats({ ownChannel: null });
  const derive = (stats: unknown, now: string, down = false) =>
    JSON.parse(JSON.stringify((context.deriveStreamStats as (a: unknown, b: number, c: boolean) => unknown)(stats, Date.parse(now), down)));

  it('is null unless the channel is tracked and live', () => {
    expect(derive(null, SERVER_TIME)).toBeNull();
    expect(derive({ ...livePayload(), tracked: false }, SERVER_TIME)).toBeNull();
    expect(derive({ ...livePayload(), live: false }, SERVER_TIME)).toBeNull();
    expect(derive({ ...livePayload(), ok: false }, SERVER_TIME)).toBeNull();
  });

  it('gives each field, null for what is missing, and no note while current', () => {
    expect(derive(livePayload(), SERVER_TIME)).toEqual({ viewers: '1,234', uptime: '1:24:15', category: 'Just Chatting', title: 'Late night run', note: null });
    expect(derive({ ok: true, tracked: true, live: true, checkedAt: CHECKED_AT }, SERVER_TIME)).toEqual({ viewers: null, uptime: null, category: null, title: null, note: null });
  });

  it('treats a missing check time as never stale', () => {
    const view = derive({ ...livePayload(), checkedAt: undefined }, '2026-11-27T12:00:00.000Z');
    expect(view.note).toBeNull();
  });
});
