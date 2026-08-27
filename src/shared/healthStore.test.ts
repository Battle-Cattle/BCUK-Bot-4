import { describe, it, expect, beforeEach, vi } from 'vitest';

let mod: Awaited<typeof import('./healthStore.js')>;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('./healthStore.js');
});

describe('Discord/Twitch chat connection state', () => {
  it('starts disconnected', () => {
    const snap = mod.getHealthSnapshot();
    expect(snap.discordConnected).toBe(false);
    expect(snap.twitchChatConnected).toBe(false);
  });

  it('recordDiscordConnected mutates state and notifies', () => {
    const listener = vi.fn();
    mod.onHealthChanged(listener);
    mod.recordDiscordConnected(true);
    expect(mod.getHealthSnapshot().discordConnected).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    mod.recordDiscordConnected(false);
    expect(mod.getHealthSnapshot().discordConnected).toBe(false);
  });

  it('recordTwitchChatConnected mutates state and notifies', () => {
    const listener = vi.fn();
    mod.onHealthChanged(listener);
    mod.recordTwitchChatConnected(true);
    expect(mod.getHealthSnapshot().twitchChatConnected).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('DB ping', () => {
  it('starts with lastPingOk true and no history', () => {
    const { db } = mod.getHealthSnapshot();
    expect(db.lastPingOk).toBe(true);
    expect(db.lastPingAt).toBeNull();
    expect(db.lastError).toBeNull();
  });

  it('recordDbPing(true) stamps lastPingAt and clears no error', () => {
    mod.recordDbPing(true);
    const { db } = mod.getHealthSnapshot();
    expect(db.lastPingOk).toBe(true);
    expect(db.lastPingAt).toBeInstanceOf(Date);
    expect(db.lastError).toBeNull();
  });

  it('recordDbPing(false, error) records the error', () => {
    mod.recordDbPing(false, 'connection refused');
    const { db } = mod.getHealthSnapshot();
    expect(db.lastPingOk).toBe(false);
    expect(db.lastError).toBe('connection refused');
  });

  it('a later ok ping leaves lastError from a previous failure intact', () => {
    mod.recordDbPing(false, 'boom');
    mod.recordDbPing(true);
    const { db } = mod.getHealthSnapshot();
    expect(db.lastPingOk).toBe(true);
    expect(db.lastError).toBe('boom');
  });
});

describe('EventSub connections', () => {
  it('starts with no streamers tracked', () => {
    expect(mod.getHealthSnapshot().eventsub).toEqual({});
  });

  it('recordEventSubConnected(true) creates a record, stamps lastConnectedAt, resets reconnectAttempts', () => {
    mod.recordEventSubReconnectAttempt('streamerA');
    mod.recordEventSubReconnectAttempt('streamerA');
    mod.recordEventSubConnected('streamerA', true);
    const entry = mod.getHealthSnapshot().eventsub['streamerA'];
    expect(entry.connected).toBe(true);
    expect(entry.lastConnectedAt).toBeInstanceOf(Date);
    expect(entry.reconnectAttempts).toBe(0);
  });

  it('recordEventSubConnected(false, error) stamps lastDisconnectedAt and records the error', () => {
    mod.recordEventSubConnected('streamerA', true);
    mod.recordEventSubConnected('streamerA', false, 'socket closed');
    const entry = mod.getHealthSnapshot().eventsub['streamerA'];
    expect(entry.connected).toBe(false);
    expect(entry.lastDisconnectedAt).toBeInstanceOf(Date);
    expect(entry.lastError).toBe('socket closed');
  });

  it('recordEventSubReconnectAttempt increments the counter, creating a record on first use', () => {
    mod.recordEventSubReconnectAttempt('streamerB');
    mod.recordEventSubReconnectAttempt('streamerB');
    expect(mod.getHealthSnapshot().eventsub['streamerB'].reconnectAttempts).toBe(2);
  });

  it('tracks multiple streamers independently', () => {
    mod.recordEventSubConnected('streamerA', true);
    mod.recordEventSubConnected('streamerB', false, 'err');
    const snap = mod.getHealthSnapshot();
    expect(snap.eventsub['streamerA'].connected).toBe(true);
    expect(snap.eventsub['streamerB'].connected).toBe(false);
  });
});

describe('Monitor poll', () => {
  it('starts with lastPollOk true and no history', () => {
    const { monitor } = mod.getHealthSnapshot();
    expect(monitor.lastPollOk).toBe(true);
    expect(monitor.lastPollAt).toBeNull();
  });

  it('recordMonitorPoll(true) stamps lastPollAt', () => {
    mod.recordMonitorPoll(true);
    const { monitor } = mod.getHealthSnapshot();
    expect(monitor.lastPollOk).toBe(true);
    expect(monitor.lastPollAt).toBeInstanceOf(Date);
  });

  it('recordMonitorPoll(false, error) records the error', () => {
    mod.recordMonitorPoll(false, 'API down');
    const { monitor } = mod.getHealthSnapshot();
    expect(monitor.lastPollOk).toBe(false);
    expect(monitor.lastError).toBe('API down');
  });
});

describe('Scheduler runs', () => {
  it('starts with no schedulers tracked', () => {
    expect(mod.getHealthSnapshot().schedulers).toEqual({});
  });

  it('recordSchedulerRun creates a record and stamps lastRunAt', () => {
    mod.recordSchedulerRun('counter', true);
    const entry = mod.getHealthSnapshot().schedulers.counter!;
    expect(entry.lastRunOk).toBe(true);
    expect(entry.lastRunAt).toBeInstanceOf(Date);
  });

  it('recordSchedulerRun(false, error) records the error', () => {
    mod.recordSchedulerRun('rewardPricing', false, 'DB shutdown');
    const entry = mod.getHealthSnapshot().schedulers.rewardPricing!;
    expect(entry.lastRunOk).toBe(false);
    expect(entry.lastError).toBe('DB shutdown');
  });

  it('tracks each named scheduler independently', () => {
    mod.recordSchedulerRun('counter', true);
    mod.recordSchedulerRun('timer', false, 'oops');
    const snap = mod.getHealthSnapshot();
    expect(snap.schedulers.counter?.lastRunOk).toBe(true);
    expect(snap.schedulers.timer?.lastRunOk).toBe(false);
  });
});

describe('Error ring buffer', () => {
  it('starts empty', () => {
    expect(mod.getHealthSnapshot().errors).toEqual([]);
  });

  it('recordError appends an entry', () => {
    mod.recordError('Discord', 'boom');
    const { errors } = mod.getHealthSnapshot();
    expect(errors).toHaveLength(1);
    expect(errors[0].module).toBe('Discord');
    expect(errors[0].message).toBe('boom');
    expect(errors[0].timestamp).toBeInstanceOf(Date);
  });

  it('trims to the newest 50 entries, evicting the oldest first', () => {
    for (let i = 0; i < 55; i++) mod.recordError('Mod', `err-${i}`);
    const { errors } = mod.getHealthSnapshot();
    expect(errors).toHaveLength(50);
    expect(errors[0].message).toBe('err-5');
    expect(errors[49].message).toBe('err-54');
  });
});

describe('onHealthChanged', () => {
  it('is not called before any mutator runs', () => {
    const listener = vi.fn();
    mod.onHealthChanged(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every registered listener, not just the most recently registered one', () => {
    const first = vi.fn();
    const second = vi.fn();
    mod.onHealthChanged(first);
    mod.onHealthChanged(second);
    mod.recordDiscordConnected(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('does not register the same listener function twice', () => {
    const listener = vi.fn();
    mod.onHealthChanged(listener);
    mod.onHealthChanged(listener);
    mod.recordDiscordConnected(true);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('getHealthSnapshot returns copies', () => {
  it('mutating the returned db object does not affect internal state', () => {
    mod.recordDbPing(true);
    const snap = mod.getHealthSnapshot();
    (snap.db as Record<string, unknown>).lastError = 'mutated';
    expect(mod.getHealthSnapshot().db.lastError).toBeNull();
  });

  it('mutating a returned eventsub entry does not affect internal state', () => {
    mod.recordEventSubConnected('streamerA', true);
    const snap = mod.getHealthSnapshot();
    (snap.eventsub['streamerA'] as unknown as Record<string, unknown>).connected = false;
    expect(mod.getHealthSnapshot().eventsub['streamerA'].connected).toBe(true);
  });

  it('mutating the returned errors array does not affect internal state', () => {
    mod.recordError('Mod', 'boom');
    const snap = mod.getHealthSnapshot();
    snap.errors.push({ timestamp: new Date(), module: 'Fake', message: 'injected' });
    expect(mod.getHealthSnapshot().errors).toHaveLength(1);
  });
});
