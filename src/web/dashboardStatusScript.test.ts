import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const utilsPath = path.join(__dirname, '../../public/dashboard-utils.js');
const statusPath = path.join(__dirname, '../../public/dashboard-status.js');

/** A minimal element: enough of the DOM for dashboard-utils.js and dashboard-status.js. */
class FakeElement {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  disabled = false;
  classList = {
    // Like DOMTokenList.add: a class already present isn't added twice.
    add: (cls: string) => {
      const classes = this.className.split(/\s+/).filter(Boolean);
      if (!classes.includes(cls)) this.className = [...classes, cls].join(' ');
    },
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
];

/** Runs the dashboard utils and status scripts in one fresh context, the way the page loads them. */
function runScripts() {
  const els = new Map(IDS.map((id) => [id, new FakeElement()]));
  /** The fake element with this id; throws if the fixture doesn't define it, so a typo fails here, not later. */
  const el = (id: string): FakeElement => {
    const found = els.get(id);
    if (!found) throw new Error(`no fake element with id "${id}"`);
    return found;
  };
  el('dot-discord').className = 'dot dot--offline';
  el('dot-voice').className = 'dot dot--inactive';
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => new FakeElement(),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(utilsPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(statusPath, 'utf8'), context);
  return { el, applyStatus: context.applyStatus as (status: unknown) => void };
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
