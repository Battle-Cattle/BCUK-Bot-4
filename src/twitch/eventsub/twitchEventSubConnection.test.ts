import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('./twitchEventSubSubscriptions', () => ({
  subscribeForStreamer: vi.fn().mockResolvedValue(1),
  removeStreamerFromMap: vi.fn(),
  dispatchNotification: vi.fn(),
  handleRevocation: vi.fn(),
}));

import {
  buildReconnectUrl,
  isDuplicate,
  isStale,
  MESSAGE_TTL_MS,
  StreamerConnection,
  EventSubMessage,
} from './twitchEventSubConnection';
import {
  subscribeForStreamer,
  dispatchNotification,
  handleRevocation,
} from './twitchEventSubSubscriptions';

// ---------------------------------------------------------------------------
// buildReconnectUrl
// ---------------------------------------------------------------------------
describe('buildReconnectUrl', () => {
  it('returns a cleaned URL for a valid Twitch reconnect URL', () => {
    const result = buildReconnectUrl('wss://eventsub.wss.twitch.tv/ws');
    expect(result).toBe('wss://eventsub.wss.twitch.tv/ws');
  });

  it('preserves query parameters from the original URL', () => {
    const result = buildReconnectUrl('wss://eventsub.wss.twitch.tv/ws?foo=bar&baz=1');
    expect(result).toContain('foo=bar');
    expect(result).toContain('baz=1');
  });

  it('returns null for wrong protocol (http)', () => {
    expect(buildReconnectUrl('http://eventsub.wss.twitch.tv/ws')).toBeNull();
  });

  it('returns null for wrong protocol (ws)', () => {
    expect(buildReconnectUrl('ws://eventsub.wss.twitch.tv/ws')).toBeNull();
  });

  it('returns null for wrong hostname', () => {
    expect(buildReconnectUrl('wss://evil.example.com/ws')).toBeNull();
  });

  it('accepts cell-specific subdomains (e.g. cell-a.eventsub.wss.twitch.tv)', () => {
    const result = buildReconnectUrl('wss://cell-a.eventsub.wss.twitch.tv/ws?challenge=abc&id=123');
    expect(result).toBe('wss://cell-a.eventsub.wss.twitch.tv/ws?challenge=abc&id=123');
  });

  it('returns null for a subdomain that only ends with twitch.tv but not the expected suffix', () => {
    expect(buildReconnectUrl('wss://evil.eventsub.wss.twitch.tv.attacker.com/ws')).toBeNull();
  });

  it('returns null when credentials are present (username)', () => {
    expect(buildReconnectUrl('wss://user@eventsub.wss.twitch.tv/ws')).toBeNull();
  });

  it('returns null when credentials are present (password)', () => {
    expect(buildReconnectUrl('wss://user:pass@eventsub.wss.twitch.tv/ws')).toBeNull();
  });

  it('returns null for an invalid (non-443) port', () => {
    expect(buildReconnectUrl('wss://eventsub.wss.twitch.tv:8080/ws')).toBeNull();
  });

  it('accepts port 443 explicitly', () => {
    const result = buildReconnectUrl('wss://eventsub.wss.twitch.tv:443/ws');
    expect(result).not.toBeNull();
  });

  it('returns null for wrong path', () => {
    expect(buildReconnectUrl('wss://eventsub.wss.twitch.tv/other')).toBeNull();
  });

  it('returns null for a malformed string', () => {
    expect(buildReconnectUrl('not a url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------
describe('isDuplicate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false on first call with a new message ID', () => {
    expect(isDuplicate('msg-unique-1')).toBe(false);
  });

  it('returns true on second call with the same message ID', () => {
    isDuplicate('msg-dup-1');
    expect(isDuplicate('msg-dup-1')).toBe(true);
  });

  it('returns false again after TTL has expired', () => {
    isDuplicate('msg-expired-1');
    vi.advanceTimersByTime(MESSAGE_TTL_MS + 1);
    expect(isDuplicate('msg-expired-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------
describe('isStale', () => {
  it('returns false for a recent timestamp', () => {
    const recent = new Date().toISOString();
    expect(isStale(recent)).toBe(false);
  });

  it('returns true for a timestamp older than MESSAGE_TTL_MS', () => {
    const old = new Date(Date.now() - MESSAGE_TTL_MS - 1000).toISOString();
    expect(isStale(old)).toBe(true);
  });

  it('returns true for an unparseable timestamp', () => {
    expect(isStale('not-a-date')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StreamerConnection.handleMessage
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<EventSubMessage> & { message_type: string; message_id?: string; message_timestamp?: string }): EventSubMessage {
  return {
    metadata: {
      message_type: overrides.message_type,
      message_id: overrides.message_id ?? `id-${Math.random()}`,
      message_timestamp: overrides.message_timestamp ?? new Date().toISOString(),
    },
    payload: overrides.payload ?? {},
  };
}

function makeStreamerData() {
  return { uid: 'uid-123', token: 'token-abc', name: 'streamer', config: null, streamerId: 1 };
}

function makeWelcomeMsg(sessionId = 'sess-1', msgId?: string): EventSubMessage {
  return makeMsg({
    message_type: 'session_welcome',
    message_id: msgId ?? `welcome-${Math.random()}`,
    payload: { session: { id: sessionId, keepalive_timeout_seconds: 10 } },
  });
}

// Suppress WebSocket construction in tests — we test handleMessage directly.
class MockWebSocket {
  addEventListener = vi.fn();
  close = vi.fn();
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('StreamerConnection.handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(subscribeForStreamer).mockResolvedValue(1);
  });

  it('session_welcome (non-reconnecting): sets sessionId and calls subscribeForStreamer', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    await (conn as any).handleMessage(makeWelcomeMsg('sess-abc'));
    expect(subscribeForStreamer).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ uid: 'uid-123' }));
  });

  it('session_welcome (non-reconnecting): calls onSelfStop when subscribeForStreamer returns 0', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(0);
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    await (conn as any).handleMessage(makeWelcomeMsg('sess-zero'));
    await vi.waitFor(() => expect(onSelfStop).toHaveBeenCalledWith('uid-123'));
  });

  it('session_welcome when isReconnecting: does NOT call subscribeForStreamer', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    // Transition to reconnecting state via a session_reconnect message (public API)
    const reconnectMsg = makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new' } },
    });
    (conn as any).handleMessage(reconnectMsg);
    await (conn as any).handleMessage(makeWelcomeMsg('sess-reconnect'));
    expect(subscribeForStreamer).not.toHaveBeenCalled();
  });

  it('notification: calls dispatchNotification', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const msg = makeMsg({
      message_type: 'notification',
      payload: {
        subscription: { type: 'channel.follow', status: 'enabled', condition: { broadcaster_user_id: 'uid-123' } },
        event: { user_login: 'follower' },
      },
    });
    (conn as any).handleMessage(msg);
    expect(dispatchNotification).toHaveBeenCalledWith(
      'channel.follow',
      { user_login: 'follower' },
      { broadcaster_user_id: 'uid-123' },
    );
  });

  it('revocation: calls handleRevocation', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const sub = { type: 'channel.follow', status: 'authorization_revoked', condition: { broadcaster_user_id: 'uid-123' } };
    const msg = makeMsg({ message_type: 'revocation', payload: { subscription: sub } });
    (conn as any).handleMessage(msg);
    expect(handleRevocation).toHaveBeenCalledWith(sub);
  });

  it('stale message: ignored — no dispatch', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const oldTs = new Date(Date.now() - MESSAGE_TTL_MS - 1000).toISOString();
    const msg = makeMsg({
      message_type: 'notification',
      message_timestamp: oldTs,
      payload: {
        subscription: { type: 'channel.follow', status: 'enabled', condition: {} },
        event: {},
      },
    });
    (conn as any).handleMessage(msg);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it('duplicate message: ignored after the first', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const msgId = `dup-test-${Math.random()}`;
    const msg1 = makeMsg({
      message_type: 'notification',
      message_id: msgId,
      payload: {
        subscription: { type: 'channel.follow', status: 'enabled', condition: {} },
        event: {},
      },
    });
    const msg2 = { ...msg1, metadata: { ...msg1.metadata } }; // same id

    (conn as any).handleMessage(msg1);
    (conn as any).handleMessage(msg2);
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it('session_keepalive: no dispatch, no error', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const msg = makeMsg({ message_type: 'session_keepalive', payload: {} });
    expect(() => (conn as any).handleMessage(msg)).not.toThrow();
    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(handleRevocation).not.toHaveBeenCalled();
  });
});
