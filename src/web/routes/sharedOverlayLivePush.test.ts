import { describe, it, expect, vi, beforeEach } from 'vitest';

const listener = vi.hoisted(() => ({ fn: undefined as undefined | (() => void) }));
const live = vi.hoisted(() => ({ states: new Map<string, boolean>() }));
vi.mock('../../shared/statusStore', () => ({
  onStatusChanged: (fn: () => void) => { listener.fn = fn; },
  getStatus: () => ({ twitch: Object.fromEntries([...live.states].map(([k, isLive]) => [k, { isLive }])) }),
}));
const conns = vi.hoisted(() => ({ sharedConnections: new Map<string, Set<unknown>>() }));
vi.mock('./sharedOverlaySource', () => ({ sharedConnections: conns.sharedConnections }));
const broadcast = vi.hoisted(() => vi.fn());
vi.mock('./sseChannel', () => ({ broadcastToChannel: broadcast }));

import { isStreamerLive } from './sharedOverlayLiveState';
import './sharedOverlayLivePush';

const change = () => listener.fn!();

beforeEach(() => {
  vi.clearAllMocks();
  conns.sharedConnections.clear();
  live.states.clear();
  change(); // forget what the previous test saw
});

describe('isStreamerLive', () => {
  it('is true only while the monitor holds the channel as live', () => {
    live.states.set('alice', true);
    live.states.set('bob', false);
    expect([isStreamerLive('alice'), isStreamerLive('bob'), isStreamerLive('nobody')]).toEqual([true, false, false]);
  });
});

describe('live-state push', () => {
  it('registers for status changes', () => {
    expect(listener.fn).toBeTypeOf('function');
  });

  it('sends nothing the first time a login is seen (its state travels in init)', () => {
    conns.sharedConnections.set('alice', new Set());
    live.states.set('alice', true);
    change();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sends the new state to that login only when it changes', () => {
    conns.sharedConnections.set('alice', new Set());
    conns.sharedConnections.set('bob', new Set());
    change();
    live.states.set('alice', true);
    change();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(conns.sharedConnections, 'alice', { type: 'live', live: true });
    change(); // no change since
    expect(broadcast).toHaveBeenCalledTimes(1);
    live.states.set('alice', false);
    change();
    expect(broadcast).toHaveBeenLastCalledWith(conns.sharedConnections, 'alice', { type: 'live', live: false });
  });

  it('forgets a login once its overlays are gone, so a reconnect is treated as new', () => {
    conns.sharedConnections.set('alice', new Set());
    change();
    conns.sharedConnections.delete('alice');
    change();
    live.states.set('alice', true);
    conns.sharedConnections.set('alice', new Set());
    change();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
