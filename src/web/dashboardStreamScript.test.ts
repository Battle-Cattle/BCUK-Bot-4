import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const streamPath = path.join(__dirname, '../../public/dashboard-stream.js');

/** A minimal element: enough of the DOM for dashboard-stream.js. */
class FakeElement {
  className = '';
  textContent = '';
  hidden = false;
  href = '';
  attributes: Record<string, string> = {};

  /** Like Element.removeAttribute; the stub's `href` property stands in for the href attribute. */
  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === 'href') this.href = '';
  }
}

const IDS = ['stream-own-state', 'stream-own-name', 'stream-own-note', 'stream-own-link'];

type Derived = { state: string; login: string | null };

/** Runs dashboard-stream.js in a fresh context with a stub DOM, the user's own channel on the body (or none), and returns its entry points. */
function runStream(ownChannel: string | null = null) {
  const els = new Map(IDS.map((id) => [id, new FakeElement()]));
  /** The fake element with this id; throws if the fixture doesn't define it, so a typo fails here, not later. */
  const el = (id: string): FakeElement => {
    const found = els.get(id);
    if (!found) throw new Error(`no fake element with id "${id}"`);
    return found;
  };
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      body: { dataset: ownChannel ? { ownChannel } : {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(streamPath, 'utf8'), context);
  const derive = context.deriveStreamOverview as (twitch: unknown, own: string | null, stale: boolean) => Derived;
  return {
    context,
    el,
    // JSON round trip: the context's objects come from another realm, which toEqual would compare by prototype.
    derive: (twitch: unknown, own: string | null, stale = false): Derived => JSON.parse(JSON.stringify(derive(twitch, own, stale))),
    apply: context.applyStreamOverview as (twitch: unknown, stale: boolean) => void,
  };
}

/** One channel's entry in the status payload's `twitch` map. */
const channel = (isLive: boolean | undefined, connected = true) => ({ connected, isLive, lastConnectedAt: null, lastDisconnectedAt: null });

describe('public/dashboard-stream.js deriveStreamOverview', () => {
  const { derive } = runStream();

  it.each([
    ['live', channel(true), 'live'],
    ['offline', channel(false), 'offline'],
  ])('reads the user\'s own channel as %s from isLive', (_name, entry, state) => {
    expect(derive({ streamer_one: entry }, 'streamer_one')).toEqual({ state, login: 'streamer_one', checkedAgo: null });
  });

  it('never lets the bot\'s connection decide: live with the bot disconnected is Live, connected but offline is Offline', () => {
    expect(derive({ streamer_one: channel(true, false) }, 'streamer_one').state).toBe('live');
    expect(derive({ streamer_one: channel(false, true) }, 'streamer_one').state).toBe('offline');
  });

  it('ignores every other channel, live or not', () => {
    const twitch = { streamer_one: channel(false), streamer_two: channel(true), streamer_three: channel(true) };

    expect(derive(twitch, 'streamer_one')).toEqual({ state: 'offline', login: 'streamer_one', checkedAgo: null });
  });

  it('says there is no channel when the user has none, even with live channels around', () => {
    expect(derive({ streamer_two: channel(true) }, null)).toEqual({ state: 'no-channel', login: null });
  });

  it('says not monitored when the user\'s channel isn\'t in the status map', () => {
    expect(derive({ streamer_two: channel(true) }, 'streamer_one')).toEqual({ state: 'not-monitored', login: 'streamer_one' });
    expect(derive({}, 'streamer_one')).toEqual({ state: 'not-monitored', login: 'streamer_one' });
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats the inherited member "%s" as not monitored, not as a channel entry', (login) => {
    expect(derive({ streamer_two: channel(true) }, login)).toEqual({ state: 'not-monitored', login });
    expect(derive({}, login)).toEqual({ state: 'not-monitored', login });
  });

  it('still reads a monitored channel whose login is named like an inherited member', () => {
    expect(derive({ constructor: channel(true) }, 'constructor')).toEqual({ state: 'live', login: 'constructor', checkedAgo: null });
  });

  it.each([
    ['before any data has arrived', null, false],
    ['for a payload that isn\'t a map', ['streamer_one'], false],
    ['for a string payload', 'streamer_one', false],
    ['while the feed is unreachable, even with a live payload', { streamer_one: channel(true) }, true],
  ])('is Unknown %s, never Offline', (_name, twitch, stale) => {
    expect(derive(twitch, 'streamer_one', stale)).toEqual({ state: 'unknown', login: 'streamer_one' });
  });

  it('is Unknown for a channel entry with no live flag, never Offline', () => {
    expect(derive({ streamer_one: channel(undefined) }, 'streamer_one').state).toBe('unknown');
    expect(derive({ streamer_one: { connected: true } }, 'streamer_one').state).toBe('unknown');
  });

  describe('stale live check (#1118)', () => {
    const NOW = Date.parse('2026-11-23T12:00:00.000Z');
    const checked = (minutesAgo: number, isLive = true) => ({ ...channel(isLive), liveCheckedAt: new Date(NOW - minutesAgo * 60_000).toISOString() });
    const run = (entry: unknown, now = NOW) => {
      const { context } = runStream('streamer_one');
      const fn = context.deriveStreamOverview as (t: unknown, o: string, f: boolean, n: number) => Derived & { checkedAgo: string | null };
      return JSON.parse(JSON.stringify(fn({ streamer_one: entry }, 'streamer_one', false, now)));
    };

    it('is current for a recent check, with no age shown', () => {
      expect(run(checked(2)).checkedAgo).toBeNull();
    });

    it('keeps the last-known state but reports its age from 3 minutes on', () => {
      expect(run(checked(3))).toEqual({ state: 'live', login: 'streamer_one', checkedAgo: '3 minutes ago' });
      expect(run(checked(5, false))).toEqual({ state: 'offline', login: 'streamer_one', checkedAgo: '5 minutes ago' });
      expect(run(checked(120)).checkedAgo).toBe('2 hours ago');
      expect(run(checked(60 * 24 * 3)).checkedAgo).toBe('3 days ago');
    });

    it.each([['absent', channel(true)], ['null', { ...channel(true), liveCheckedAt: null }], ['not a date', { ...channel(true), liveCheckedAt: 'nope' }]])(
      'is unchanged when liveCheckedAt is %s',
      (_name, entry) => {
        expect(run(entry)).toEqual({ state: 'live', login: 'streamer_one', checkedAgo: null });
      },
    );

    it('shows the stale state and its age in words on the panel', () => {
      const { apply, el } = runStream('streamer_one');
      // The script runs in its own realm with its own clock, so age the stamp against the real time.
      const stamp = new Date(Date.now() - 7 * 60_000 - 5_000).toISOString();
      apply({ streamer_one: { ...channel(true), liveCheckedAt: stamp } }, false);
      expect(el('stream-own-state').textContent).toBe('Live (last known)');
      expect(el('stream-own-note').textContent).toBe('Last known state; live status last checked 7 minutes ago.');
    });
  });

  it('is deterministic and reads nothing but its arguments', () => {
    const twitch = { streamer_one: channel(true) };

    expect(derive(twitch, 'streamer_one')).toEqual(derive(twitch, 'streamer_one'));
    expect(twitch).toEqual({ streamer_one: channel(true) });
  });
});

describe('public/dashboard-stream.js applyStreamOverview', () => {
  it('shows Live as a filled pill\'s style modifier and words, with the channel and a link to it', () => {
    const { el, apply } = runStream('streamer_one');
    apply({ streamer_one: channel(true) }, false);

    expect(el('stream-own-state').textContent).toBe('Live');
    expect(el('stream-own-state').className).toBe('stream-state stream-state--live');
    expect(el('stream-own-name').textContent).toBe('streamer_one');
    expect(el('stream-own-name').hidden).toBe(false);
    expect(el('stream-own-note').textContent).toBe('Broadcasting now.');
    expect(el('stream-own-link').href).toBe('https://www.twitch.tv/streamer_one');
    expect(el('stream-own-link').textContent).toBe('Open on Twitch');
    expect(el('stream-own-link').hidden).toBe(false);
  });

  it('shows Offline as its own deliberate state, with no live-only values and a way to the channel', () => {
    const { el, apply } = runStream('streamer_one');
    apply({ streamer_one: channel(false) }, false);

    expect(el('stream-own-state').textContent).toBe('Offline');
    expect(el('stream-own-state').className).toBe('stream-state stream-state--offline');
    expect(el('stream-own-note').textContent).toBe('Not broadcasting right now.');
    expect(el('stream-own-link').textContent).toBe('Go to Twitch');
  });

  it('shows the three non-live states with distinct words and style modifiers', () => {
    const states = [
      [{ streamer_one: channel(undefined) }, 'Unknown', 'stream-state--unknown'],
      [{ other_one: channel(true) }, 'Not monitored', 'stream-state--unavailable'],
    ] as const;
    for (const [twitch, label, modifier] of states) {
      const { el, apply } = runStream('streamer_one');
      apply(twitch, false);
      expect(el('stream-own-state').textContent).toBe(label);
      expect(el('stream-own-state').className).toBe(`stream-state ${modifier}`);
    }
  });

  it('says to ask a Manager or Admin when no channel is linked, with no link and no name', () => {
    const { el, apply } = runStream(null);
    apply({ streamer_two: channel(true) }, false);

    expect(el('stream-own-state').textContent).toBe('No channel');
    expect(el('stream-own-note').textContent).toContain('Ask a Manager or Admin');
    expect(el('stream-own-name').hidden).toBe(true);
    expect(el('stream-own-link').hidden).toBe(true);
    expect(el('stream-own-link').href).toBe('');
  });

  it('goes Unknown when told the feed is unreachable, keeping the channel name but dropping nothing into Offline', () => {
    const { el, apply } = runStream('streamer_one');
    apply({ streamer_one: channel(true) }, false);
    apply(null, true);

    expect(el('stream-own-state').textContent).toBe('Unknown');
    expect(el('stream-own-name').textContent).toBe('streamer_one');
  });

  it('never builds a link from a value that isn\'t a valid Twitch login', () => {
    const { el, apply } = runStream('ab');
    apply({ ab: channel(true) }, false);

    expect(el('stream-own-link').hidden).toBe(true);
    expect(el('stream-own-link').href).toBe('');
  });

  it('redraws only when what it would show has changed', () => {
    const { el, apply } = runStream('streamer_one');
    apply({ streamer_one: channel(true) }, false);
    el('stream-own-state').textContent = 'edited by the test';

    apply({ streamer_one: channel(true), streamer_two: channel(true) }, false);
    expect(el('stream-own-state').textContent).toBe('edited by the test');

    apply({ streamer_one: channel(false) }, false);
    expect(el('stream-own-state').textContent).toBe('Offline');
  });

  it('copes with a page that has no Stream Overview markup, or no body data', () => {
    const context: Record<string, unknown> = { document: { getElementById: () => null } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(streamPath, 'utf8'), context);

    expect(() => (context.applyStreamOverview as (t: unknown, s: boolean) => void)({ streamer_one: channel(true) }, false)).not.toThrow();
  });
});
