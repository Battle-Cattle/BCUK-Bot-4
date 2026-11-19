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
  'dot-discord', 'discord-tag', 'discord-guild', 'dot-voice', 'voice-channel', 'voice-state', 'btn-rejoin-voice',
  'last-command', 'last-file', 'last-source', 'last-when', 'twitch-channels',
];

/** Runs the dashboard utils and status scripts in one fresh context, the way the page loads them. */
function runScripts() {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement()]));
  els['dot-discord']!.className = 'dot dot--offline';
  els['dot-voice']!.className = 'dot dot--offline';
  const context: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: () => new FakeElement(),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(utilsPath, 'utf8'), context);
  vm.runInContext(fs.readFileSync(statusPath, 'utf8'), context);
  return { els, applyStatus: context.applyStatus as (status: unknown) => void };
}

/** An /api/status payload with the given Discord, voice and Twitch states. */
function status(discordReady: boolean, voice: { connected: boolean; playing?: boolean }, twitch: Record<string, unknown> = {}) {
  return { discord: { ready: discordReady, tag: 'Bot#0001', guildName: 'Guild' }, voice: { channelName: 'General', ...voice }, twitch };
}

describe('public/dashboard-status.js status dots', () => {
  it.each([
    [true, 'dot--online', 'Discord: Connected'],
    [false, 'dot--offline', 'Discord: Disconnected'],
  ])('names the Discord dot in words (ready=%s)', (ready, cls, label) => {
    const { els, applyStatus } = runScripts();
    applyStatus(status(ready, { connected: false }));

    const dot = els['dot-discord']!;
    expect(dot.className).toBe(`dot ${cls}`);
    expect(dot.attributes['aria-label']).toBe(label);
    expect(dot.attributes.title).toBe(label);
  });

  it.each([
    [{ connected: false }, 'dot--offline', 'Voice: Not connected'],
    [{ connected: true, playing: false }, 'dot--online', 'Voice: Connected, idle'],
    [{ connected: true, playing: true }, 'dot--playing', 'Voice: Playing'],
  ])('names the voice dot in words for %o', (voice, cls, label) => {
    const { els, applyStatus } = runScripts();
    applyStatus(status(true, voice));

    const dot = els['dot-voice']!;
    expect(dot.className).toBe(`dot ${cls}`);
    expect(dot.attributes['aria-label']).toBe(label);
  });

  it('replaces the previous state class and name when the state changes', () => {
    const { els, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true, playing: true }));
    applyStatus(status(false, { connected: false }));

    expect(els['dot-voice']!.className).toBe('dot dot--offline');
    expect(els['dot-voice']!.attributes['aria-label']).toBe('Voice: Not connected');
    expect(els['dot-discord']!.attributes['aria-label']).toBe('Discord: Disconnected');
  });
});

describe('public/dashboard-status.js Twitch channel badges', () => {
  it('labels every channel badge in text: Connected, Disconnected and LIVE', () => {
    const { els, applyStatus } = runScripts();
    applyStatus(status(true, { connected: true }, {
      live_one: { connected: true, isLive: true, lastConnectedAt: null, lastDisconnectedAt: null },
      quiet_one: { connected: false, isLive: false, lastConnectedAt: null, lastDisconnectedAt: null },
    }));

    const badges = els['twitch-channels']!.descendants().filter((e) => e.className.startsWith('badge '));
    expect(badges.map((b) => [b.className, b.textContent])).toEqual([
      ['badge badge-live', 'LIVE'],
      ['badge badge-online', 'Connected'],
      ['badge badge-offline', 'Disconnected'],
    ]);
  });
});
