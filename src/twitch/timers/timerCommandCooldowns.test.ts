import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TimerCommandForScheduler } from '../../db';
import {
  pickRowsToFire, releaseReservations, pruneStaleCooldowns, clearCooldowns,
} from './timerCommandCooldowns';

/** Builds a minimal timer-command row for exercising the cooldown logic. */
function timerRow(overrides: Partial<TimerCommandForScheduler> = {}): TimerCommandForScheduler {
  return {
    id: 1,
    channel: 'channelA',
    message: 'hello',
    interval_seconds: 600,
    min_messages: 0,
    require_live: true,
    ...overrides,
  };
}

beforeEach(() => {
  clearCooldowns();
});

describe('pickRowsToFire', () => {
  it('passes a lone row with no Shared Chat session straight through both layers', () => {
    const row = timerRow({ channel: 'ch1' });
    const result = pickRowsToFire([row], new Map(), 1000, () => 0);
    expect(result).toEqual([{ row, sessionKey: null }]);
  });

  it('picks only the longest-waiting row within a Shared Chat command-session group', () => {
    const rowA = timerRow({ id: 1, channel: 'chA' });
    const rowB = timerRow({ id: 1, channel: 'chB' });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);
    const lastFiredAtOf = (r: TimerCommandForScheduler) => (r.channel === 'chA' ? 500 : 100);

    const result = pickRowsToFire([rowA, rowB], sessionIdByChannel, 10_000, lastFiredAtOf);

    expect(result).toHaveLength(1);
    expect(result[0].row).toBe(rowB);
    expect(result[0].sessionKey).toBe('1::s1');
  });

  it('withholds a command-session group still inside its own cooldown window', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    const first = pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);
    expect(first).toHaveLength(1);

    // Still within the 600s cooldown reserved by the first pick.
    const second = pickRowsToFire([rowA, rowB], sessionIdByChannel, 599_000, () => 0);
    expect(second).toHaveLength(0);
  });

  it('allows a command-session group to fire again once its cooldown elapses', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);
    const second = pickRowsToFire([rowA, rowB], sessionIdByChannel, 600_000, () => 0);
    expect(second).toHaveLength(1);
  });

  it('defers a different timer sharing a channel while the channel floor is active', () => {
    const timer1 = timerRow({ id: 1, channel: 'ch1' });
    const timer2 = timerRow({ id: 2, channel: 'ch1' });

    const first = pickRowsToFire([timer1, timer2], new Map(), 0, () => 0);
    expect(first).toEqual([{ row: timer1, sessionKey: null }]);

    // Only timer2 is eligible this tick, floor (120s) still active, and it's not a
    // repeat of the last poster (timer1) — the whole channel is deferred.
    const second = pickRowsToFire([timer2], new Map(), 60_000, () => 0);
    expect(second).toEqual([]);
  });

  it('does not throttle a repeat of the channel floor last poster', () => {
    const timer1 = timerRow({ id: 1, channel: 'ch1' });
    const timer2 = timerRow({ id: 2, channel: 'ch1' });

    pickRowsToFire([timer1, timer2], new Map(), 0, () => 0);

    // timer1 (the last poster) is eligible again well inside the 120s floor — it's
    // allowed straight through since the floor only holds back *different* commands.
    const second = pickRowsToFire([timer1], new Map(), 60_000, (r) => (r.id === 1 ? 60_000 : 0));
    expect(second).toEqual([{ row: timer1, sessionKey: null }]);
  });

  it('lets whichever eligible row has waited longest win the channel once the floor clears', () => {
    const timer1 = timerRow({ id: 1, channel: 'ch1' });
    const timer2 = timerRow({ id: 2, channel: 'ch1' });

    pickRowsToFire([timer1, timer2], new Map(), 0, () => 0);

    // Past the 120s floor: both are eligible again, timer2 has waited longer.
    const second = pickRowsToFire(
      [timer1, timer2],
      new Map(),
      130_000,
      (r) => (r.id === 1 ? 130_000 : 0),
    );
    expect(second).toEqual([{ row: timer2, sessionKey: null }]);
  });
});

describe('releaseReservations', () => {
  it('frees a command-session reservation so the group can be picked again immediately', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    const [picked] = pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);
    releaseReservations(picked.sessionKey, picked.row.channel, picked.row.id, 0);

    // Well inside the original 600s cooldown, but the reservation was released.
    const retry = pickRowsToFire([rowA, rowB], sessionIdByChannel, 1000, () => 0);
    expect(retry).toHaveLength(1);
  });

  it('does not release a newer reservation made after the one being released', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);
    // Cooldown elapses; a second, newer reservation is made for the same group.
    pickRowsToFire([rowA, rowB], sessionIdByChannel, 600_000, () => 0);

    // Releasing with the *first* reservation's stale `now` must not clobber the newer one.
    releaseReservations('1::s1', 'chA', 1, 0);

    const stillCoolingDown = pickRowsToFire([rowA, rowB], sessionIdByChannel, 600_500, () => 0);
    expect(stillCoolingDown).toHaveLength(0);
  });

  it('does not release a channel-floor reservation made by a different timer', () => {
    const timer1 = timerRow({ id: 1, channel: 'ch1' });
    const timer2 = timerRow({ id: 2, channel: 'ch1' });

    pickRowsToFire([timer1, timer2], new Map(), 0, () => 0);

    // Wrong timerId for the current channel-floor reservation (which belongs to timer1).
    releaseReservations(null, 'ch1', 2, 0);

    // The floor is still active and unrelated to timer1 — a different timer is still deferred.
    const deferred = pickRowsToFire([timer2], new Map(), 60_000, () => 0);
    expect(deferred).toEqual([]);
  });
});

describe('pruneStaleCooldowns / clearCooldowns', () => {
  it('runs without error against empty state', () => {
    expect(() => pruneStaleCooldowns(Date.now())).not.toThrow();
  });

  it('does not disturb an active cooldown reservation well within its prune window', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);

    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    pruneStaleCooldowns(1000);
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockRestore();

    const stillCoolingDown = pickRowsToFire([rowA, rowB], sessionIdByChannel, 1000, () => 0);
    expect(stillCoolingDown).toHaveLength(0);
  });

  it('drops a command-session cooldown entry once it is far older than its own cooldown window', () => {
    // cooldownMs = 600_000 (interval_seconds * 1000); the prune factor is 10x that.
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);

    pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);

    // The deletion isn't independently observable through pickRowsToFire (the
    // cooldown gate already reopens once elapsed time exceeds cooldownMs, long
    // before the prune threshold), so spy on Map.prototype.delete to confirm the
    // stale entry is actually removed rather than just asserting no throw.
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    pruneStaleCooldowns(6_000_001);
    expect(deleteSpy).toHaveBeenCalledWith('1::s1');
    deleteSpy.mockRestore();
  });

  it('clears all reservations so every group can be picked again immediately', () => {
    const rowA = timerRow({ id: 1, channel: 'chA', interval_seconds: 600 });
    const rowB = timerRow({ id: 1, channel: 'chB', interval_seconds: 600 });
    const sessionIdByChannel = new Map([['chA', 's1'], ['chB', 's1']]);
    const timer1 = timerRow({ id: 1, channel: 'ch1' });
    const timer2 = timerRow({ id: 2, channel: 'ch1' });

    pickRowsToFire([rowA, rowB], sessionIdByChannel, 0, () => 0);
    pickRowsToFire([timer1, timer2], new Map(), 0, () => 0);
    clearCooldowns();

    expect(pickRowsToFire([rowA, rowB], sessionIdByChannel, 1000, () => 0)).toHaveLength(1);
    expect(pickRowsToFire([timer2], new Map(), 1000, () => 0)).toHaveLength(1);
  });
});
