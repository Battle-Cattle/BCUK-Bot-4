import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/dashboard-health.js');

interface Health {
  state: string;
  label: string;
  components: { discord: string; twitch: string };
}

/** A minimal #health-indicator element. */
interface FakeIndicator {
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  writes: number;
}

/** Runs public/dashboard-health.js in a fresh context with an optional #health-indicator stub. */
function runScript(withIndicator = true) {
  let writes = 0;
  const indicator = {
    dataset: { state: 'unknown' } as Record<string, string>,
    className: 'health health--unknown',
    _text: 'Status unknown',
    get textContent() {
      return this._text;
    },
    set textContent(value: string) {
      writes++;
      this._text = value;
    },
  };
  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => (withIndicator && id === 'health-indicator' ? indicator : null) },
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  return {
    deriveHealth: context.deriveHealth as (status: unknown, feedAvailable: boolean) => Health,
    renderHealth: context.renderHealth as (health: Health) => void,
    indicator: (): FakeIndicator => ({ ...indicator, textContent: indicator._text, writes }),
  };
}

/** A Twitch channel entry; `isLive` is deliberately independent of `connected`. */
function channel(connected: unknown, isLive = false) {
  return { connected, isLive, lastConnectedAt: null, lastDisconnectedAt: null };
}

describe('public/dashboard-health.js deriveHealth', () => {
  const { deriveHealth } = runScript();

  it.each([
    ['all required services healthy', { discord: { ready: true }, twitch: { a: channel(true), b: channel(true) } }, 'healthy', 'All Systems Operational'],
    ['Discord down', { discord: { ready: false }, twitch: { a: channel(true) } }, 'unhealthy', 'Service down'],
    ['some Twitch channels connected', { discord: { ready: true }, twitch: { a: channel(true), b: channel(false) } }, 'degraded', 'Degraded'],
    ['no Twitch channel connected', { discord: { ready: true }, twitch: { a: channel(false), b: channel(false) } }, 'unhealthy', 'Service down'],
    ['zero channels configured (neutral, not a fault or unknown)', { discord: { ready: true }, twitch: {} }, 'healthy', 'All Systems Operational'],
    ['a connected channel that is offline (not live)', { discord: { ready: true }, twitch: { a: channel(true, false) } }, 'healthy', 'All Systems Operational'],
    ['a live channel whose chat bot is disconnected', { discord: { ready: true }, twitch: { a: channel(false, true) } }, 'unhealthy', 'Service down'],
  ])('%s', (_case, status, state, label) => {
    const health = deriveHealth(status, true);

    expect(health.state).toBe(state);
    expect(health.label).toBe(label);
  });

  it('reports the zero-channel Twitch component as neutral', () => {
    expect(deriveHealth({ discord: { ready: true }, twitch: {} }, true).components.twitch).toBe('neutral');
  });

  it.each([
    [{ connected: false }],
    [{ connected: true }],
    [{ connected: true, playing: true }],
  ])('ignores voice (%o)', (voice) => {
    const base = { discord: { ready: true }, twitch: { a: channel(true) } };

    expect(deriveHealth({ ...base, voice }, true).state).toBe('healthy');
  });

  it('is Unknown whenever the feed is unavailable, whatever the last payload said', () => {
    const health = deriveHealth({ discord: { ready: true }, twitch: { a: channel(true) } }, false);

    expect(health.state).toBe('unknown');
    expect(health.label).toBe('Status unknown');
  });

  it.each([
    ['no payload', null],
    ['a non-object payload', 'oops'],
    ['Discord missing', { twitch: { a: channel(true) } }],
    ['Discord ready not a boolean', { discord: {}, twitch: { a: channel(true) } }],
    ['Twitch missing (unlike {})', { discord: { ready: true } }],
    ['a channel with no known connection, the rest connected', { discord: { ready: true }, twitch: { a: channel(true), b: channel(undefined) } }],
  ])('is Unknown, never healthy, with %s', (_case, status) => {
    const health = deriveHealth(status, true);

    expect(health.state).toBe('unknown');
    expect(health.label).not.toBe('All Systems Operational');
  });

  it.each([
    ['Discord down, Twitch unknown', { discord: { ready: false } }, 'unhealthy'],
    ['Discord unknown, Twitch degraded', { twitch: { a: channel(true), b: channel(false) } }, 'degraded'],
    ['a disconnected channel plus one with no known connection', { discord: { ready: true }, twitch: { a: channel(false), b: channel(undefined), c: channel(true) } }, 'degraded'],
  ])('lets a known failure outrank an unknown: %s', (_case, status, state) => {
    expect(deriveHealth(status, true).state).toBe(state);
  });

  it('says "All Systems Operational" only when every counted service is healthy', () => {
    const statuses = [
      { discord: { ready: true }, twitch: { a: channel(true) } },
      { discord: { ready: true }, twitch: {} },
      { discord: { ready: false }, twitch: { a: channel(true) } },
      { discord: { ready: true }, twitch: { a: channel(false) } },
      { discord: { ready: true } },
      null,
    ];
    for (const status of statuses) {
      for (const feed of [true, false]) {
        const health = deriveHealth(status, feed);

        expect(health.label === 'All Systems Operational').toBe(health.state === 'healthy');
        // Healthy implies Discord, a required service, is positively known healthy.
        expect(health.state !== 'healthy' || health.components.discord === 'healthy').toBe(true);
      }
    }
  });
});

describe('public/dashboard-health.js renderHealth', () => {
  it('writes the state class and words', () => {
    const { deriveHealth, renderHealth, indicator } = runScript();
    renderHealth(deriveHealth({ discord: { ready: false }, twitch: {} }, true));

    expect(indicator()).toMatchObject({ className: 'health health--unhealthy', textContent: 'Service down', dataset: { state: 'unhealthy' } });
  });

  it.each([
    [{ discord: { ready: true }, twitch: {} }, 'All Systems Operational'],
    [{ discord: { ready: true }, twitch: { a: channel(true), b: channel(false) } }, 'Degraded'],
    [{ discord: { ready: false }, twitch: {} }, 'Service down'],
  ])('renders each state label for %o', (status, label) => {
    const { deriveHealth, renderHealth, indicator } = runScript();
    renderHealth(deriveHealth(status, true));

    expect(indicator().textContent).toBe(label);
  });

  it('never renders "All Systems Operational" when the feed is unavailable', () => {
    const { deriveHealth, renderHealth, indicator } = runScript();
    renderHealth(deriveHealth({ discord: { ready: true }, twitch: {} }, true));
    renderHealth(deriveHealth({ discord: { ready: true }, twitch: {} }, false));

    expect(indicator().textContent).toBe('Status unknown');
    expect(indicator().className).toBe('health health--unknown');
  });

  it('does not rewrite (re-announce) the live region when the state is unchanged', () => {
    const { deriveHealth, renderHealth, indicator } = runScript();
    const healthy = { discord: { ready: true }, twitch: { a: channel(true) } };
    renderHealth(deriveHealth(healthy, true));
    renderHealth(deriveHealth(healthy, true));
    renderHealth(deriveHealth({ ...healthy, voice: { connected: false } }, true));

    expect(indicator().writes).toBe(1);
  });

  it('does nothing without an indicator element', () => {
    const { deriveHealth, renderHealth } = runScript(false);

    expect(() => renderHealth(deriveHealth(null, false))).not.toThrow();
  });
});
