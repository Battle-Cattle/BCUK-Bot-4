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
  removeStreamerFromMap,
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
// Listeners are captured by event name so lifecycle tests can invoke them manually.
class MockWebSocket {
  listeners = new Map<string, (...args: any[]) => void>();
  addEventListener = vi.fn((event: string, cb: (...args: any[]) => void) => {
    this.listeners.set(event, cb);
  });
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

// ---------------------------------------------------------------------------
// StreamerConnection lifecycle: connect/stop/reload/reconnect
// ---------------------------------------------------------------------------

describe('StreamerConnection lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(subscribeForStreamer).mockResolvedValue(1);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() opens a WebSocket and registers the four lifecycle listeners', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;
    expect(ws.listeners.has('open')).toBe(true);
    expect(ws.listeners.has('message')).toBe(true);
    expect(ws.listeners.has('close')).toBe(true);
    expect(ws.listeners.has('error')).toBe(true);
  });

  it('stop() closes the socket, clears timers, and removes the streamer from the map', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;

    conn.stop();

    expect(ws.close).toHaveBeenCalledWith(1000, 'shutdown');
    expect((conn as any).ws).toBeNull();
    expect(removeStreamerFromMap).toHaveBeenCalledWith('uid-123');
  });

  it('does not reconnect after a close once stopped', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;
    conn.stop();

    ws.listeners.get('close')!({ code: 1000, reason: 'shutdown' } as any);
    vi.advanceTimersByTime(60_000);

    expect((conn as any).ws).toBeNull();
    expect((conn as any).reconnectTimer).toBeNull();
  });

  it('schedules a reconnect with exponential backoff when the socket closes unexpectedly', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;

    firstWs.listeners.get('close')!({ code: 1006, reason: 'abnormal' } as any);
    expect((conn as any).reconnectAttempts).toBe(1);

    vi.advanceTimersByTime(1_000);
    const secondWs = (conn as any).ws as MockWebSocket;
    expect(secondWs).not.toBe(firstWs);

    secondWs.listeners.get('close')!({ code: 1006, reason: 'abnormal' } as any);
    vi.advanceTimersByTime(1_999);
    expect((conn as any).ws).toBeNull();
    vi.advanceTimersByTime(1);
    expect((conn as any).ws).not.toBeNull();
  });

  it('ignores a close event from a stale socket replaced during session migration', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const staleWs = (conn as any).ws as MockWebSocket;

    // Simulate a session_reconnect: a new socket is opened, the old one is left dangling.
    conn.connect('wss://eventsub.wss.twitch.tv/ws?session_id=new');
    const currentWs = (conn as any).ws as MockWebSocket;
    expect(currentWs).not.toBe(staleWs);

    staleWs.listeners.get('close')!({ code: 1000, reason: 'reconnect' } as any);

    expect((conn as any).ws).toBe(currentWs);
  });

  it('reload() connects immediately when there is no live session', () => {
    const conn = new StreamerConnection(makeStreamerData());
    const connectSpy = vi.spyOn(conn, 'connect');

    conn.reload(makeStreamerData());

    return vi.waitFor(() => expect(connectSpy).toHaveBeenCalled());
  });

  it('reload() re-subscribes on the live session and stops when no subscriptions remain', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));
    vi.mocked(subscribeForStreamer).mockResolvedValue(0);

    conn.reload(makeStreamerData());
    await vi.waitFor(() => expect(removeStreamerFromMap).toHaveBeenCalled());

    expect(subscribeForStreamer).toHaveBeenCalledWith('sess-live', expect.objectContaining({ uid: 'uid-123' }));
  });

  it('serialises overlapping reload() calls through the reload chain', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));

    // First reload's subscribeForStreamer call stays pending until resolveFirst() fires,
    // so we can prove the second reload's call doesn't start until the first one settles.
    let resolveFirst!: (value: number) => void;
    const firstDeferred = new Promise<number>((resolve) => { resolveFirst = resolve; });
    vi.mocked(subscribeForStreamer)
      .mockImplementationOnce(() => firstDeferred)
      .mockResolvedValueOnce(1);

    conn.reload(makeStreamerData());
    conn.reload(makeStreamerData());

    // Flush pending microtasks so the first reload's doReload() has had a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    // Only the welcome handshake + first reload have fired — the second reload is still
    // chained behind the first's unresolved promise. If reloadChain didn't serialise the
    // calls, the second reload would have fired immediately too, making this 3.
    expect(subscribeForStreamer).toHaveBeenCalledTimes(2);

    resolveFirst(1);
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(3));
  });
});
