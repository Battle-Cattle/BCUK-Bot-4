import { describe, it, expect } from 'vitest';
import { deriveComponentOks } from './ownerAlertHealth';
import { MONITOR_STALE_MS, SCHEDULER_STALE_MS, type HealthSnapshot } from '../shared/healthStore';

/** Builds a fully-healthy baseline snapshot, overridable per test via a partial deep-merge of the top-level keys. */
function makeSnapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    discordConnected: true,
    twitchChatConnected: true,
    db: { lastPingOk: true, lastPingAt: new Date(), lastError: null },
    eventsub: {},
    monitor: { lastPollAt: new Date(), lastPollOk: true, lastError: null },
    schedulers: {},
    errors: [],
    ...overrides,
  };
}

describe('deriveComponentOks', () => {
  it('reports discord/twitchChat/db as ok when the snapshot is fully healthy', () => {
    const result = deriveComponentOks(makeSnapshot());
    expect(result.get('discord')).toEqual({ ok: true, error: null });
    expect(result.get('twitchChat')).toEqual({ ok: true, error: null });
    expect(result.get('db')).toEqual({ ok: true, error: null });
  });

  it('reports discord/twitchChat as failing with a default error when disconnected', () => {
    const result = deriveComponentOks(makeSnapshot({ discordConnected: false, twitchChatConnected: false }));
    expect(result.get('discord')).toEqual({ ok: false, error: 'Discord gateway disconnected' });
    expect(result.get('twitchChat')).toEqual({ ok: false, error: 'Twitch chat disconnected' });
  });

  it('reports db failing with its own error message when set, falling back to a default otherwise', () => {
    const withMessage = deriveComponentOks(makeSnapshot({ db: { lastPingOk: false, lastPingAt: null, lastError: 'connection refused' } }));
    expect(withMessage.get('db')).toEqual({ ok: false, error: 'connection refused' });

    const withoutMessage = deriveComponentOks(makeSnapshot({ db: { lastPingOk: false, lastPingAt: null, lastError: null } }));
    expect(withoutMessage.get('db')).toEqual({ ok: false, error: 'DB ping failed' });
  });

  it('adds one eventsub:<streamer> entry per tracked streamer', () => {
    const result = deriveComponentOks(makeSnapshot({
      eventsub: {
        streamerA: { connected: true, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 0, lastError: null },
        streamerB: { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 2, lastError: 'socket closed' },
      },
    }));
    expect(result.get('eventsub:streamerA')).toEqual({ ok: true, error: null });
    expect(result.get('eventsub:streamerB')).toEqual({ ok: false, error: 'socket closed' });
  });

  it('falls back to a default eventsub error message when none is recorded', () => {
    const result = deriveComponentOks(makeSnapshot({
      eventsub: { streamerC: { connected: false, lastConnectedAt: null, lastDisconnectedAt: null, reconnectAttempts: 0, lastError: null } },
    }));
    expect(result.get('eventsub:streamerC')).toEqual({ ok: false, error: 'EventSub disconnected for streamerC' });
  });

  it('reports monitor as failing when the last poll itself failed', () => {
    const result = deriveComponentOks(makeSnapshot({
      monitor: { lastPollAt: new Date(), lastPollOk: false, lastError: 'poll error' },
    }));
    expect(result.get('monitor')).toEqual({ ok: false, error: 'poll error' });
  });

  it('reports monitor as failing (stale) when the last poll is older than MONITOR_STALE_MS, even if it reported ok', () => {
    const result = deriveComponentOks(makeSnapshot({
      monitor: { lastPollAt: new Date(Date.now() - MONITOR_STALE_MS - 1), lastPollOk: true, lastError: null },
    }));
    expect(result.get('monitor')).toEqual({ ok: false, error: 'Stream monitor poll is stale' });
  });

  it('reports monitor as ok when it has never polled (lastPollAt null) and lastPollOk is true', () => {
    const result = deriveComponentOks(makeSnapshot({ monitor: { lastPollAt: null, lastPollOk: true, lastError: null } }));
    expect(result.get('monitor')).toEqual({ ok: true, error: null });
  });

  it('adds one scheduler:<name> entry per tracked scheduler and skips undefined entries', () => {
    const result = deriveComponentOks(makeSnapshot({
      schedulers: {
        counter: { lastRunAt: new Date(), lastRunOk: true, lastError: null },
        timer: { lastRunAt: new Date(), lastRunOk: false, lastError: 'archive failed' },
      },
    }));
    expect(result.get('scheduler:counter')).toEqual({ ok: true, error: null });
    expect(result.get('scheduler:timer')).toEqual({ ok: false, error: 'archive failed' });
    expect(result.has('scheduler:rewardPricing')).toBe(false);
  });

  it('reports a scheduler as failing (stale) when its last run is older than SCHEDULER_STALE_MS, even if it reported ok', () => {
    const result = deriveComponentOks(makeSnapshot({
      schedulers: { counter: { lastRunAt: new Date(Date.now() - SCHEDULER_STALE_MS - 1), lastRunOk: true, lastError: null } },
    }));
    expect(result.get('scheduler:counter')).toEqual({ ok: false, error: 'counter scheduler run is stale' });
  });
});
