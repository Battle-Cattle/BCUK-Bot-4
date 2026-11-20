import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const utilsPath = path.join(__dirname, '../../public/dashboard-utils.js');
const healthPath = path.join(__dirname, '../../public/dashboard-health.js');
const statusPath = path.join(__dirname, '../../public/dashboard-status.js');

/** A minimal element: enough of the DOM for dashboard-utils.js and dashboard-status.js. */
class FakeElement {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  classList = {
    // Like DOMTokenList.add: a class already present isn't added twice.
    add: (cls: string) => {
      const classes = this.className.split(/\s+/).filter(Boolean);
      if (!classes.includes(cls)) this.className = [...classes, cls].join(' ');
    },
    // Like DOMTokenList.toggle with `force`.
    toggle: (cls: string, force: boolean) => {
      const classes = this.className.split(/\s+/).filter((c) => c && c !== cls);
      this.className = (force ? [...classes, cls] : classes).join(' ');
    },
    contains: (cls: string) => this.className.split(/\s+/).includes(cls),
  };

  get firstChild(): FakeElement | undefined {
    return this.children[0];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): void {
    this.children = this.children.filter((c) => c !== child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  /** Every element under this one, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
}

const IDS = [
  'dot-discord', 'discord-state', 'discord-tag', 'discord-guild', 'dot-voice', 'voice-channel', 'voice-state',
  'btn-rejoin-voice', 'last-command', 'last-file', 'last-source', 'last-when', 'twitch-channels',
  'health-indicator', 'bot-status', 'status-stale-note', 'twitch-state',
];

/**
 * A fake /api/status response: `null` is a network error, a number is that HTTP status, an object is a 200 body,
 * and a promise is a 200 body that arrives when the test resolves it.
 */
type FetchResult = null | number | Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Runs the dashboard utils, health and status scripts in one fresh context, the way the page loads them.
 * `fetch` answers /api/status from `responses` in order (a 503 once they run out).
 */
function runScripts(responses: FetchResult[] = []) {
  const els = new Map(IDS.map((id) => [id, new FakeElement()]));
  /** The fake element with this id; throws if the fixture doesn't define it, so a typo fails here, not later. */
  const el = (id: string): FakeElement => {
    const found = els.get(id);
    if (!found) throw new Error(`no fake element with id "${id}"`);
    return found;
  };
  el('dot-discord').className = 'dot dot--offline';
  el('dot-voice').className = 'dot dot--inactive';
  el('health-indicator').className = 'health health--unknown';
  el('health-indicator').dataset.state = 'unknown';
  el('health-indicator').textContent = 'Status unknown';
  el('bot-status').className = 'section dashboard-status';
  el('status-stale-note').hidden = true;
  const fetch = (): Promise<unknown> => {
    const next = responses.length > 0 ? responses.shift() : 503;
    if (next === null || next === undefined) return Promise.reject(new Error('offline'));
    if (typeof next === 'number') return Promise.resolve({ ok: false, status: next, json: () => Promise.resolve({}) });
    if (next instanceof Promise) return next.then((body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(next) });
  };
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => new FakeElement(),
    },
    fetch,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(utilsPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(healthPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(statusPath, 'utf8'), context);
  return {
    el,
    applyStatus: context.applyStatus as (status: unknown) => void,
    fetchStatus: context.fetchStatus as () => Promise<void>,
    setStatusStreamOpen: context.setStatusStreamOpen as (open: boolean) => void,
    isStatusFeedStale: context.isStatusFeedStale as () => boolean,
  };
}

/** An /api/status payload with the given Discord, voice and Twitch states. */
function status(discordReady: boolean, voice: { connected: boolean; playing?: boolean }, twitch: Record<string, unknown> = {}) {
  return { discord: { ready: discordReady, tag: 'Bot#0001', guildName: 'Guild' }, voice: { channelName: 'General', ...voice }, twitch };
}

describe('public/dashboard-status.js Discord card', () => {
  it.each([
    [true, 'dot--online', 'Discord: Connected', 'Connected', 'connected'],
    [false, 'dot--offline', 'Discord: Disconnected', 'Disconnected', 'disconnected'],
  ])('shows ready=%s as a named dot and visible state text', (ready, dotCls, label, text, modifier) => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(ready, { connected: false }));

    expect(el('dot-discord').className).toBe(`dot ${dotCls}`);
    expect(el('dot-discord').attributes['aria-label']).toBe(label);
    expect(el('dot-discord').attributes.title).toBe(label);
    expect(el('discord-state').textContent).toBe(text);
    expect(el('discord-state').className).toBe(`stat-value status-text status-text--${modifier}`);
  });
});

describe('public/dashboard-status.js Voice card', () => {
  it.each([
    [{ connected: false }, 'dot--inactive', 'Voice: Not connected', 'Not connected', 'inactive'],
    [{ connected: true, playing: false }, 'dot--online', 'Voice: Connected, idle', 'Idle', 'idle'],
    [{ connected: true, playing: true }, 'dot--playing', 'Voice: Playing', 'Playing', 'playing'],
  ])('shows %o as a named dot and visible state text', (voice, dotCls, label, text, modifier) => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, voice));

    expect(el('dot-voice').className).toBe(`dot ${dotCls}`);
    expect(el('dot-voice').attributes['aria-label']).toBe(label);
    expect(el('voice-state').textContent).toBe(text);
    expect(el('voice-state').className).toBe(`stat-value status-text status-text--${modifier}`);
  });

  it('never styles voice as a fault: no inline colour and no red/amber state class', () => {
    const { el, applyStatus } = runScripts();
    for (const voice of [{ connected: false }, { connected: true, playing: true }, { connected: true }]) {
      applyStatus(status(true, voice));

      expect(el('voice-state').style.color).toBeUndefined();
      expect(el('voice-state').className).not.toMatch(/disconnected|offline/);
      expect(el('dot-voice').className).not.toContain('dot--offline');
    }
  });

  it('keeps the Join/Leave Voice label in step with the connection', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }));
    expect(el('btn-rejoin-voice').textContent).toBe('Leave Voice');

    applyStatus(status(true, { connected: false }));
    expect(el('btn-rejoin-voice').textContent).toBe('Join Voice');
  });
});

describe('public/dashboard-status.js Last Played card', () => {
  it('shows the last command, file, source and when it played', () => {
    const { el, applyStatus } = runScripts();
    const payload = status(true, { connected: true });
    applyStatus({
      ...payload,
      voice: { ...payload.voice, lastCommand: '!clap', currentFile: 'clap.mp3', lastSource: 'twitch', lastPlayedAt: new Date().toISOString() },
    });

    expect(el('last-command').textContent).toBe('!clap');
    expect(el('last-file').textContent).toBe('clap.mp3');
    expect(el('last-source').textContent).toBe('twitch');
    expect(el('last-when').textContent).toBe('just now');
  });

  it('shows dashes when nothing has played yet', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: false }));

    for (const id of ['last-command', 'last-file', 'last-source', 'last-when']) expect(el(id).textContent).toBe('—');
  });
});

describe('public/dashboard-status.js state changes', () => {
  it('replaces the previous classes, names and text when the state changes', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true, playing: true }));
    applyStatus(status(false, { connected: false }));

    expect(el('dot-voice').className).toBe('dot dot--inactive');
    expect(el('dot-voice').attributes['aria-label']).toBe('Voice: Not connected');
    expect(el('voice-state').textContent).toBe('Not connected');
    expect(el('dot-discord').attributes['aria-label']).toBe('Discord: Disconnected');
    expect(el('discord-state').textContent).toBe('Disconnected');
  });
});

describe('public/dashboard-status.js Twitch channel badges', () => {
  it('labels every channel badge in text: Connected, Disconnected and LIVE', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, {
      live_one: { connected: true, isLive: true, lastConnectedAt: null, lastDisconnectedAt: null },
      quiet_one: { connected: false, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null },
    }));

    const badges = el('twitch-channels').descendants().filter((e) => e.className.startsWith('badge '));
    expect(badges.map((b) => [b.className, b.textContent])).toEqual([
      ['badge badge-live', 'LIVE'],
      ['badge badge-online', 'Connected'],
      ['badge badge-offline', 'Disconnected'],
    ]);
  });
});

describe('public/dashboard-status.js health indicator and feed staleness', () => {
  const healthy = status(true, { connected: true }, { a: { connected: true, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null } });

  it('renders the overall health from each applied status', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(healthy);
    expect(el('health-indicator').textContent).toBe('All Systems Operational');

    applyStatus(status(false, { connected: true }));
    expect(el('health-indicator').textContent).toBe('Service down');
  });

  it('goes Unknown, even after a malformed payload throws part-way through', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(healthy);

    expect(() => applyStatus({ voice: {} })).toThrow();
    expect(el('health-indicator').textContent).toBe('Status unknown');
  });

  it('marks everything not current after 3 failed fetches with the stream down', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen, isStatusFeedStale } = runScripts([503, null, 500]);
    applyStatus(healthy);
    setStatusStreamOpen(false);
    await fetchStatus();
    await fetchStatus();
    expect(isStatusFeedStale()).toBe(false);

    await fetchStatus();

    expect(isStatusFeedStale()).toBe(true);
    expect(el('health-indicator').textContent).toBe('Status unknown');
    expect(el('health-indicator').textContent).not.toBe('All Systems Operational');
    expect(el('bot-status').classList.contains('is-stale')).toBe(true);
    expect(el('status-stale-note').hidden).toBe(false);
    expect(el('discord-state').textContent).toBe('Unknown');
    expect(el('voice-state').textContent).toBe('Unknown');
    expect(el('dot-discord').className).toBe('dot dot--unknown');
    expect(el('dot-discord').attributes['aria-label']).toBe('Discord: Status unknown');
  });

  it('stays current while the stream is still open, however many fetches fail', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen, isStatusFeedStale } = runScripts([503, 503, 503, 503]);
    applyStatus(healthy);
    setStatusStreamOpen(true);
    for (let i = 0; i < 4; i++) await fetchStatus();

    expect(isStatusFeedStale()).toBe(false);
    expect(el('health-indicator').textContent).toBe('All Systems Operational');
  });

  it('goes Unknown as soon as the stream drops if fetches have already failed 3 times', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen } = runScripts([503, 503, 503]);
    applyStatus(healthy);
    setStatusStreamOpen(true);
    for (let i = 0; i < 3; i++) await fetchStatus();
    expect(el('health-indicator').textContent).toBe('All Systems Operational');

    setStatusStreamOpen(false);

    expect(el('health-indicator').textContent).toBe('Status unknown');
  });

  it('stays Unknown when the stream merely reopens, and recovers on fresh data', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen, isStatusFeedStale } = runScripts([503, 503, 503, healthy]);
    applyStatus(healthy);
    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();

    setStatusStreamOpen(true);
    expect(isStatusFeedStale()).toBe(true);
    expect(el('health-indicator').textContent).toBe('Status unknown');

    await fetchStatus();

    expect(isStatusFeedStale()).toBe(false);
    expect(el('health-indicator').textContent).toBe('All Systems Operational');
    expect(el('bot-status').classList.contains('is-stale')).toBe(false);
    expect(el('status-stale-note').hidden).toBe(true);
    expect(el('discord-state').textContent).toBe('Connected');
    expect(el('dot-voice').className).toBe('dot dot--online');
  });

  it('recovers when a stream message brings fresh data', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen } = runScripts([503, 503, 503]);
    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();

    applyStatus(status(false, { connected: false }));

    expect(el('health-indicator').textContent).toBe('Service down');
    expect(el('discord-state').textContent).toBe('Disconnected');
  });

  it('no longer overwrites the Discord account with "(status unavailable)"', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen } = runScripts([503, 503, 503]);
    applyStatus(healthy);
    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();

    expect(el('discord-tag').textContent).toBe('Bot#0001');
  });
});

describe('public/dashboard-status.js zero Twitch channels', () => {
  it('stays healthy (zero channels is neutral) and says in words that none are configured', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, {}));

    expect(el('health-indicator').textContent).toBe('All Systems Operational');
    expect(el('twitch-channels').descendants().map((e) => e.textContent)).toContain('No Twitch channels configured.');
  });

  it('rolls zero channels up as a neutral "No channels configured", not a fault', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, {}));

    expect(el('twitch-state').textContent).toBe('No channels configured');
    expect(el('twitch-state').className).toBe('stat-value status-text status-text--inactive');
  });
});

describe('public/dashboard-status.js Twitch connection roll-up', () => {
  const up = { connected: true, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null };
  const down = { connected: false, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null };

  it.each([
    ['all channels connected', { a: up, b: up }, 'Connected', 'connected'],
    ['one channel connected of three', { a: up, b: down, c: down }, 'Degraded (1 of 3)', 'degraded'],
    ['all but one connected', { a: up, b: up, c: down }, 'Degraded (2 of 3)', 'degraded'],
    ['no channel connected', { a: down, b: down }, 'Disconnected', 'disconnected'],
    ['a single connected channel', { a: up }, 'Connected', 'connected'],
    ['a single disconnected channel', { a: down }, 'Disconnected', 'disconnected'],
  ])('reads %s as "%s"', (_name, twitch, text, modifier) => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, twitch));

    expect(el('twitch-state').textContent).toBe(text);
    expect(el('twitch-state').className).toBe(`stat-value status-text status-text--${modifier}`);
  });

  it('agrees with the header indicator about when Twitch is degraded or down', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { a: up, b: down }));
    expect([el('twitch-state').textContent, el('health-indicator').textContent]).toEqual(['Degraded (1 of 2)', 'Degraded']);

    applyStatus(status(true, { connected: true }, { a: down, b: down }));
    expect([el('twitch-state').textContent, el('health-indicator').textContent]).toEqual(['Disconnected', 'Service down']);
  });

  it('reads a channel with no connection state as Unknown, never as Connected', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { a: { isLive: false } }));

    expect(el('twitch-state').textContent).toBe('Unknown');
    expect(el('twitch-state').className).toBe('stat-value status-text status-text--unknown');
  });

  it('follows each applied status, and goes Unknown with the other cards while the feed is unreachable', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen } = runScripts([503, 503, 503]);
    applyStatus(status(true, { connected: true }, { a: up }));
    expect(el('twitch-state').textContent).toBe('Connected');

    applyStatus(status(true, { connected: true }, { a: down }));
    expect(el('twitch-state').textContent).toBe('Disconnected');

    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();
    expect(el('twitch-state').textContent).toBe('Unknown');
    expect(el('twitch-state').className).toBe('stat-value status-text status-text--unknown');
  });

  it('shows each channel\'s last connected or disconnected time, and LIVE only for a connected live channel', () => {
    const { el, applyStatus } = runScripts();
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    applyStatus(status(true, { connected: true }, {
      up_live: { connected: true, isLive: true, lastConnectedAt: minutesAgo(5), lastDisconnectedAt: minutesAgo(90) },
      down_live: { connected: false, isLive: true, lastConnectedAt: minutesAgo(90), lastDisconnectedAt: minutesAgo(30) },
    }));

    const items = el('twitch-channels').children;
    const metaOf = (item: FakeElement) => item.descendants().find((e) => e.className === 'channel-meta')?.textContent;
    // A connected channel shows when it connected, a disconnected one when it dropped: never "Never seen".
    expect(items.map(metaOf)).toEqual(['5m ago', '30m ago']);
    const badgesOf = (item: FakeElement) => item.descendants().filter((e) => e.className.startsWith('badge ')).map((e) => e.textContent);
    expect(items.map(badgesOf)).toEqual([['LIVE', 'Connected'], ['Disconnected']]);
  });

  it('lays each channel out as one row: its name and last-seen time together, then its badges (#1076)', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, {
      up_live: { connected: true, isLive: true, lastConnectedAt: null, lastDisconnectedAt: null },
    }));

    const [item] = el('twitch-channels').children;
    expect(item?.children.map((c) => c.className)).toEqual(['channel-info', 'channel-badges']);
    expect(item?.children[0]?.children.map((c) => [c.className, c.textContent])).toEqual([
      ['channel-name', 'up_live'],
      ['channel-meta', 'Never seen'],
    ]);
    expect(item?.children[1]?.children.map((c) => c.textContent)).toEqual(['LIVE', 'Connected']);
  });

  it('leaves each channel\'s own connection badge and last-seen time as they were', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { a: up, b: down }));

    const texts = el('twitch-channels').descendants().map((e) => e.textContent);
    expect(texts).toEqual(expect.arrayContaining(['a', 'b', 'Connected', 'Disconnected', 'Never seen']));
  });
});

describe('public/dashboard-status.js update ordering', () => {
  const healthy = status(true, { connected: true }, { a: { connected: true, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null } });

  it('drops a fetch response that a newer stream message overtook', async () => {
    let resolveFetch: (body: Record<string, unknown>) => void = () => {};
    const slow = new Promise<Record<string, unknown>>((resolve) => { resolveFetch = resolve; });
    const { el, applyStatus, fetchStatus } = runScripts([slow]);

    const pending = fetchStatus();
    applyStatus(status(false, { connected: false })); // the newer stream message
    resolveFetch(healthy); // the older snapshot lands afterwards
    await pending;

    expect(el('health-indicator').textContent).toBe('Service down');
    expect(el('discord-state').textContent).toBe('Disconnected');
  });

  it('still applies a pending fetch when the stream message in between was malformed', async () => {
    let resolveFetch: (body: Record<string, unknown>) => void = () => {};
    const slow = new Promise<Record<string, unknown>>((resolve) => { resolveFetch = resolve; });
    const { el, applyStatus, fetchStatus } = runScripts([slow]);

    const pending = fetchStatus();
    expect(() => applyStatus({ discord: { ready: true }, twitch: {} })).toThrow(); // no voice section
    resolveFetch(healthy);
    await pending;

    expect(el('health-indicator').textContent).toBe('All Systems Operational');
    expect(el('discord-state').textContent).toBe('Connected');
  });

  it('still applies a fetch response nothing overtook', async () => {
    const { el, fetchStatus } = runScripts([healthy]);
    await fetchStatus();

    expect(el('health-indicator').textContent).toBe('All Systems Operational');
  });

  it('counts 200 responses with malformed bodies as failures, so three in a row with the stream down go Unknown', async () => {
    const malformed = { discord: { ready: true }, twitch: {} }; // no voice section: applying it throws
    const { el, applyStatus, fetchStatus, setStatusStreamOpen, isStatusFeedStale } = runScripts([malformed, malformed, malformed]);
    applyStatus(healthy);
    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();

    expect(isStatusFeedStale()).toBe(true);
    expect(el('bot-status').classList.contains('is-stale')).toBe(true);
    expect(el('health-indicator').textContent).toBe('Status unknown');
  });

  it('keeps the cards marked not current when a fresh payload is malformed', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen, isStatusFeedStale } = runScripts([503, 503, 503]);
    applyStatus(healthy);
    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();

    expect(() => applyStatus({ discord: { ready: true }, twitch: {} })).toThrow(); // no voice section

    expect(isStatusFeedStale()).toBe(true);
    expect(el('bot-status').classList.contains('is-stale')).toBe(true);
    expect(el('status-stale-note').hidden).toBe(false);
    expect(el('health-indicator').textContent).toBe('Status unknown');
  });
});
