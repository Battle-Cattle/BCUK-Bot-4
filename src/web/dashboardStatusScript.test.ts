import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const utilsPath = path.join(__dirname, '../../public/dashboard-utils.js');
const healthPath = path.join(__dirname, '../../public/dashboard-health.js');
const streamPath = path.join(__dirname, '../../public/dashboard-stream.js');
const lastPlayedPath = path.join(__dirname, '../../public/dashboard-last-played.js');
const statusPath = path.join(__dirname, '../../public/dashboard-status.js');

/** A minimal element: enough of the DOM for dashboard-utils.js and dashboard-status.js. */
class FakeElement {
  /** The tag name the script asked for (`createElement('bdi')`), so a test can check which names are isolated. */
  tag = '';
  dateTime = '';
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  href = '';
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

  /** Names written as text only: assigning markup must never happen (the real innerHTML would parse it). */
  set innerHTML(_value: string) {
    throw new Error('innerHTML must not be used for names');
  }

  /** All the text in this element and under it, in order (what a reader would see on the line). */
  get allText(): string {
    return this.textContent + this.children.map((c) => c.allText).join('');
  }

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

  /** Like Element.removeAttribute; the stub's `href` property stands in for the href attribute. */
  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === 'href') this.href = '';
  }

  /** Every element under this one, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
}

const IDS = [
  'dot-discord', 'discord-state', 'discord-tag', 'discord-guild', 'dot-voice', 'voice-channel', 'voice-state',
  'btn-rejoin-voice', 'voice-last-played', 'twitch-channels',
  'health-indicator', 'bot-status', 'status-stale-note', 'twitch-state', 'dot-twitch',
  'stream-own-state', 'stream-own-name', 'stream-own-note', 'stream-own-link',
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
function runScripts(responses: FetchResult[] = [], ownChannel: string | null = null) {
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
      createElement: (tag: string) => Object.assign(new FakeElement(), { tag }),
      createTextNode: (text: string) => Object.assign(new FakeElement(), { tag: '#text', textContent: text }),
      // The server puts the signed-in user's own channel on the body as data-own-channel (absent when they have none).
      body: { dataset: ownChannel ? { ownChannel } : {} },
    },
    fetch,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(utilsPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(healthPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(streamPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(lastPlayedPath, 'utf8'), context);
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

describe('public/dashboard-status.js last-played line in the Voice service (#1141)', () => {
  const payloadWith = (voice: Record<string, unknown>) => {
    const payload = status(true, { connected: true });
    return { ...payload, voice: { ...payload.voice, ...voice } };
  };
  const played = { lastCommand: '!clap', lastFile: 'clap.mp3', lastPlayedAt: new Date().toISOString() };

  it('shows the command, file, Twitch channel, who and when on one line', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastSource: 'twitch', lastChannel: 'streamer_one', lastUser: 'user1' }));

    expect(el('voice-last-played').allText).toBe('!clap (clap.mp3) · Twitch #streamer_one · user1 · just now');
  });

  it('names a Discord sound by Discord and its user only, never a channel', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastSource: 'discord', lastChannel: 'mod-secret', lastUser: 'user1' }));

    expect(el('voice-last-played').allText).toBe('!clap (clap.mp3) · Discord · user1 · just now');
    expect(el('voice-last-played').allText).not.toContain('mod-secret');
  });

  it('names a Stream Deck sound without a user when none is known', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastSource: 'streamdeck', lastUser: null }));

    expect(el('voice-last-played').allText).toBe('!clap (clap.mp3) · Stream Deck · just now');
  });

  it('leaves out a part that is unknown instead of inventing it, and shows a bare time with nothing else', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ lastPlayedAt: played.lastPlayedAt, lastSource: 'nonsense', lastCommand: '', lastFile: 42, lastUser: null }));

    expect(el('voice-last-played').allText).toBe('just now');
  });

  it('keeps the file after playback ends: it reads lastFile, not currentFile', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, currentFile: null, playing: false, lastSource: 'discord' }));

    expect(el('voice-last-played').allText).toContain('clap.mp3');
  });

  it('says nothing has played since the bot started, as an explicit line', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: false }));

    expect(el('voice-last-played').textContent).toBe('Nothing played since the bot started');
  });

  it('treats an unparseable time as nothing played, never a made-up one', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastPlayedAt: 'not a date', lastSource: 'discord' }));

    expect(el('voice-last-played').textContent).toBe('Nothing played since the bot started');
  });

  it('writes each name as text in its own isolating <bdi>, never as markup', () => {
    const { el, applyStatus } = runScripts();
    // The stub's innerHTML setter throws, so any markup path would fail this test outright.
    applyStatus(payloadWith({ ...played, lastSource: 'twitch', lastChannel: 'streamer_one', lastUser: '<img src=x onerror=1> \u05d0\u05d1' }));

    const line = el('voice-last-played');
    const names = line.descendants().filter((e) => e.tag === 'bdi').map((e) => e.textContent);
    expect(names).toEqual(['!clap', 'clap.mp3', 'streamer_one', '<img src=x onerror=1> \u05d0\u05d1']);
    expect(line.descendants().filter((e) => e.tag === 'img')).toHaveLength(0);
  });

  it('puts the time in a <time> element with its date', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastSource: 'discord' }));

    const time = el('voice-last-played').descendants().find((e) => e.tag === 'time');
    expect(time?.dateTime).toBe(played.lastPlayedAt);
  });

  it('redraws from scratch on each status, so an earlier play never lingers', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(payloadWith({ ...played, lastSource: 'twitch', lastChannel: 'streamer_one', lastUser: 'user1' }));
    applyStatus(payloadWith({ ...played, lastCommand: '!ding', lastFile: 'ding.mp3', lastSource: 'streamdeck', lastChannel: null, lastUser: null }));

    expect(el('voice-last-played').allText).toBe('!ding (ding.mp3) · Stream Deck · just now');
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

describe('public/dashboard-status.js stale live check on channel rows (#1118)', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const row = (extra: Record<string, unknown>) => ({ connected: true, isLive: true, lastConnectedAt: null, lastDisconnectedAt: null, ...extra });
  const texts = (els: { descendants(): { className: string; textContent: string }[] }) => els.descendants().map((e) => e.textContent);

  it('keeps LIVE with a recent check', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { live_one: row({ liveCheckedAt: at(1) }) }));

    expect(texts(el('twitch-channels'))).toContain('LIVE');
    expect(texts(el('twitch-channels')).join('|')).not.toContain('last checked');
  });

  it('shows a stale live channel as last seen live, with its age in words and no LIVE badge', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { live_one: row({ liveCheckedAt: at(5) }) }));

    const all = texts(el('twitch-channels'));
    expect(all).toContain('WAS LIVE');
    expect(all).not.toContain('LIVE');
    expect(all).toContain('Live status last checked 5 minutes ago');
  });

  it('says an offline channel\'s live status is stale too, with no LIVE or WAS LIVE badge', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { quiet_one: row({ isLive: false, liveCheckedAt: at(6) }) }));

    const all = texts(el('twitch-channels'));
    expect(all).toContain('Live status last checked 6 minutes ago');
    expect(all).not.toContain('LIVE');
    expect(all).not.toContain('WAS LIVE');
  });

  it('leaves a row with liveCheckedAt but no isLive flag without stale text', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { odd_one: row({ isLive: undefined, liveCheckedAt: at(9) }) }));

    expect(texts(el('twitch-channels')).join('|')).not.toContain('last checked');
  });

  it('turns stale at exactly 3 minutes and not before', () => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { edge_one: row({ liveCheckedAt: at(3) }), edge_two: row({ liveCheckedAt: at(2.9) }) }));

    const all = texts(el('twitch-channels'));
    expect(all.filter((t) => t === 'WAS LIVE')).toHaveLength(1);
    expect(all.filter((t) => t === 'LIVE')).toHaveLength(1);
  });

  it.each([['absent', {}], ['null', { liveCheckedAt: null }]])('is unchanged when liveCheckedAt is %s', (_n, extra) => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, { live_one: row(extra) }));

    expect(texts(el('twitch-channels'))).toContain('LIVE');
  });
});

describe('public/dashboard-status.js Stream Overview', () => {
  const up = { connected: true, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null };
  const liveButDisconnected = { connected: false, isLive: true, lastConnectedAt: null, lastDisconnectedAt: null };

  it('follows every applied status for the user\'s own channel, by isLive and not by the bot\'s connection (#1114)', () => {
    const { el, applyStatus } = runScripts([], 'streamer_one');

    applyStatus(status(true, { connected: true }, { streamer_one: liveButDisconnected }));
    expect([el('stream-own-state').textContent, el('stream-own-name').textContent]).toEqual(['Live', 'streamer_one']);
    // System Status says the bot is down while Stream Overview still says Live; the row's own LIVE badge needs the connection.
    expect(el('twitch-state').textContent).toBe('Disconnected');

    applyStatus(status(true, { connected: true }, { streamer_one: up }));
    expect(el('stream-own-state').textContent).toBe('Offline');
  });

  it('goes Unknown with the other cards while the feed is unreachable, and recovers to Live when fresh data arrives (#1114)', async () => {
    const { el, applyStatus, fetchStatus, setStatusStreamOpen } = runScripts([503, 503, 503], 'streamer_one');
    applyStatus(status(true, { connected: true }, { streamer_one: { ...up, isLive: true } }));
    expect(el('stream-own-state').textContent).toBe('Live');

    setStatusStreamOpen(false);
    for (let i = 0; i < 3; i++) await fetchStatus();
    expect(el('stream-own-state').textContent).toBe('Unknown');
    expect(el('stream-own-state').className).toBe('stream-state stream-state--unknown');

    // Recovery: applyStatus writes the cards before it clears the stale flag, so the panel must not read that flag.
    applyStatus(status(true, { connected: true }, { streamer_one: { ...up, isLive: true } }));
    expect(el('stream-own-state').textContent).toBe('Live');
  });

  it('goes Unknown, like the health indicator, when a malformed payload throws part-way through, and recovers on the next good one (#1114)', () => {
    const { el, applyStatus } = runScripts([], 'streamer_one');
    applyStatus(status(true, { connected: true }, { streamer_one: { ...up, isLive: true } }));
    expect(el('stream-own-state').textContent).toBe('Live');

    expect(() => applyStatus({ voice: {} })).toThrow();
    expect(el('health-indicator').textContent).toBe('Status unknown');
    expect(el('stream-own-state').textContent).toBe('Unknown');

    applyStatus(status(true, { connected: true }, { streamer_one: { ...up, isLive: true } }));
    expect(el('stream-own-state').textContent).toBe('Live');
  });

  it('says there is no channel when the user has none, whatever the payload (#1114)', () => {
    const { el, applyStatus } = runScripts([], null);
    applyStatus(status(true, { connected: true }, { streamer_one: { ...up, isLive: true } }));

    expect(el('stream-own-state').textContent).toBe('No channel');
    expect(el('stream-own-link').hidden).toBe(true);
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

  it.each([
    ['all channels connected', { a: up, b: up }, 'dot dot--online', 'Twitch: Connected'],
    ['some channels connected', { a: up, b: down }, 'dot dot--degraded', 'Twitch: Degraded (1 of 2)'],
    ['no channel connected', { a: down }, 'dot dot--offline', 'Twitch: Disconnected'],
    ['no channels configured', {}, 'dot dot--inactive', 'Twitch: No channels configured'],
    ['a channel with no connection state', { a: { isLive: false } }, 'dot dot--unknown', 'Twitch: Unknown'],
  ])('draws the Twitch dot with its own shape and name for %s (#1137)', (_name, twitch, dotClass, label) => {
    const { el, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, twitch));

    expect(el('dot-twitch').className).toBe(dotClass);
    expect(el('dot-twitch').attributes['aria-label']).toBe(label);
    expect(el('dot-twitch').attributes.title).toBe(label);
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
    expect(el('dot-twitch').className).toBe('dot dot--unknown');
    expect(el('dot-twitch').attributes['aria-label']).toBe('Twitch: Status unknown');
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
