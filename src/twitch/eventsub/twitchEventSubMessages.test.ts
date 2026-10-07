import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('./twitchEventSubDispatch', () => ({ dispatchNotification: vi.fn(), handleRevocation: vi.fn() }));

import { rejectionReason, routeEventSubMessage, seenMessageIds, type EventSubMessage } from './twitchEventSubMessages';
import { dispatchNotification, handleRevocation } from './twitchEventSubDispatch';

const now = () => new Date().toISOString();

function makeMsg(type: string, payload: EventSubMessage['payload'] = {}): EventSubMessage {
  return { metadata: { message_type: type, message_id: 'id', message_timestamp: now() }, payload };
}

describe('rejectionReason', () => {
  beforeEach(() => { seenMessageIds.clear(); });

  it('accepts a fresh, unseen message and then flags its repeat as a duplicate', () => {
    expect(rejectionReason('m1', now())).toBeNull();
    expect(rejectionReason('m1', now())).toBe('Duplicate');
  });

  it('flags a stale message without recording its id', () => {
    expect(rejectionReason('m2', '2000-01-01T00:00:00Z')).toBe('Stale');
    expect(seenMessageIds.has('m2')).toBe(false);
  });
});

describe('routeEventSubMessage', () => {
  const handlers = () => ({ onWelcome: vi.fn(), onReconnect: vi.fn() });
  beforeEach(() => { vi.clearAllMocks(); });

  it('routes session_welcome to onWelcome', () => {
    const h = handlers();
    const msg = makeMsg('session_welcome', { session: { id: 's', keepalive_timeout_seconds: 10 } });
    routeEventSubMessage(msg, h);
    expect(h.onWelcome).toHaveBeenCalledWith(msg);
  });

  it('routes session_reconnect with a URL to onReconnect, and ignores one without', () => {
    const h = handlers();
    routeEventSubMessage(makeMsg('session_reconnect', { session: { id: 's', keepalive_timeout_seconds: 10, reconnect_url: 'wss://x' } }), h);
    routeEventSubMessage(makeMsg('session_reconnect', { session: { id: 's', keepalive_timeout_seconds: 10, reconnect_url: null } }), h);
    expect(h.onReconnect).toHaveBeenCalledTimes(1);
    expect(h.onReconnect).toHaveBeenCalledWith('wss://x');
  });

  it('dispatches notifications that carry both a subscription and an event', () => {
    const sub = { type: 'channel.follow', status: 'enabled', condition: { broadcaster_user_id: '1' } };
    routeEventSubMessage(makeMsg('notification', { subscription: sub, event: { a: 1 } }), handlers());
    routeEventSubMessage(makeMsg('notification', { subscription: sub }), handlers());
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith('channel.follow', { a: 1 }, sub.condition);
  });

  it('passes revocations to handleRevocation and does nothing for keepalives', () => {
    const sub = { type: 'channel.raid', status: 'authorization_revoked', condition: {} };
    const h = handlers();
    routeEventSubMessage(makeMsg('revocation', { subscription: sub }), h);
    routeEventSubMessage(makeMsg('session_keepalive'), h);
    expect(handleRevocation).toHaveBeenCalledWith(sub);
    expect(h.onWelcome).not.toHaveBeenCalled();
    expect(h.onReconnect).not.toHaveBeenCalled();
  });
});
