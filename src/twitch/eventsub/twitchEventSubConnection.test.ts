import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A single hoisted instance so tests can assert on it — the module captures `log` at import time.
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../shared/logger', () => ({ createLogger: () => mockLog }));
vi.mock('./twitchEventSubSubscriptions', () => ({
  subscribeForStreamer: vi.fn().mockResolvedValue({ desired: 1, live: 1, transientFailures: 0 }),
  fetchValidEventSubToken: vi.fn().mockResolvedValue('token-abc'),
  removeSessionSubscriptions: vi.fn().mockResolvedValue(undefined),
  removeStreamerFromMap: vi.fn(),
  dispatchNotification: vi.fn(),
  handleRevocation: vi.fn(),
}));
vi.mock('../../shared/healthStore', () => ({
  recordEventSubConnected: vi.fn(),
  recordEventSubReconnectAttempt: vi.fn(),
  removeEventSubHealth: vi.fn(),
}));

import { StreamerConnection } from './twitchEventSubConnection';
import {
  buildReconnectUrl,
  isDuplicate,
  isStale,
  MESSAGE_TTL_MS,
  purgeExpiredMessageIds,
  seenMessageIds,
  type EventSubMessage,
} from './twitchEventSubMessages';
import {
  subscribeForStreamer,
  fetchValidEventSubToken,
  removeSessionSubscriptions,
  dispatchNotification,
  handleRevocation,
  removeStreamerFromMap,
} from './twitchEventSubSubscriptions';
import { recordEventSubConnected, removeEventSubHealth } from '../../shared/healthStore';

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
// purgeExpiredMessageIds
// ---------------------------------------------------------------------------
describe('purgeExpiredMessageIds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    seenMessageIds.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes only the entries whose TTL has passed', () => {
    isDuplicate('msg-old');
    vi.advanceTimersByTime(MESSAGE_TTL_MS / 2);
    isDuplicate('msg-new');
    vi.advanceTimersByTime(MESSAGE_TTL_MS / 2 + 1); // msg-old is now past its TTL, msg-new is not

    purgeExpiredMessageIds();

    expect(seenMessageIds.has('msg-old')).toBe(false);
    expect(seenMessageIds.has('msg-new')).toBe(true);
  });

  it('keeps an entry that expires exactly now, matching isDuplicate treating it as still seen', () => {
    isDuplicate('msg-edge');
    vi.advanceTimersByTime(MESSAGE_TTL_MS);

    purgeExpiredMessageIds();

    expect(seenMessageIds.has('msg-edge')).toBe(true);
    expect(isDuplicate('msg-edge')).toBe(true);
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

/** Builds a subscribeForStreamer outcome with `live` subscriptions out of `desired`. */
function outcome(live: number, transientFailures = 0, desired = Math.max(live + transientFailures, 1)) {
  return { desired, live, transientFailures };
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
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(1));
  });

  it('session_welcome (non-reconnecting): sets sessionId and calls subscribeForStreamer', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    await (conn as any).handleMessage(makeWelcomeMsg('sess-abc'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ uid: 'uid-123' })));
  });

  it('session_welcome (non-reconnecting): calls onSelfStop when subscribeForStreamer returns 0', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0));
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    await (conn as any).handleMessage(makeWelcomeMsg('sess-zero'));
    await vi.waitFor(() => expect(onSelfStop).toHaveBeenCalledWith('uid-123'));
  });

  it('ignores a pending subscribeAndHandleEmpty result once the connection has been stopped', async () => {
    let resolveSubscribe!: (value: ReturnType<typeof outcome>) => void;
    vi.mocked(subscribeForStreamer).mockReturnValue(new Promise((resolve) => { resolveSubscribe = resolve; }));

    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-abc'));

    // The welcome's subscribeForStreamer call is now in flight (pending). Stop the
    // connection externally — e.g. twitchEventSub.ts removing this streamer — while it's
    // still awaiting Twitch's response.
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));
    conn.stop();
    vi.mocked(removeStreamerFromMap).mockClear();

    // The pending subscribe now resolves with zero subscriptions — without the `stopped`
    // guard, this would call stop() a second time and fire onSelfStop for an already-closed
    // connection.
    resolveSubscribe(outcome(0));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));
    // Flush a few more microtask ticks to give a missing guard a chance to fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(onSelfStop).not.toHaveBeenCalled();
    expect(removeStreamerFromMap).not.toHaveBeenCalled();
    // Nothing was created, so there's nothing on the closed session to clean up.
    expect(removeSessionSubscriptions).not.toHaveBeenCalled();
  });

  it('deletes subscriptions a subscribe call created after the connection was stopped mid-flight', async () => {
    let resolveSubscribe!: (value: ReturnType<typeof outcome>) => void;
    vi.mocked(subscribeForStreamer).mockReturnValue(new Promise((resolve) => { resolveSubscribe = resolve; }));
    const data = makeStreamerData();
    const conn = new StreamerConnection(data);
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-abc'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));

    conn.stop();
    resolveSubscribe(outcome(3));

    await vi.waitFor(() => expect(removeSessionSubscriptions).toHaveBeenCalledWith('sess-abc', data));
    expect(onSelfStop).not.toHaveBeenCalled();
  });

  it('does not clean up subscriptions when the connection is still live', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));

    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-live', expect.anything()));
    await Promise.resolve();
    expect(removeSessionSubscriptions).not.toHaveBeenCalled();
  });

  it('ignores a zero-count result from a session superseded mid-subscribe instead of stopping the healthy replacement', async () => {
    let resolveFirst!: (value: ReturnType<typeof outcome>) => void;
    vi.mocked(subscribeForStreamer)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-A'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-A', expect.anything()));

    // Socket A dies and a replacement socket B welcomes while A's subscribe is still in flight.
    (conn as any).forceReconnect((conn as any).ws);
    (conn as any).connect();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-B'));

    // A's creates all failed against the dead session.
    resolveFirst(outcome(0));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-B', expect.anything()));
    await Promise.resolve();
    await Promise.resolve();
    expect(onSelfStop).not.toHaveBeenCalled();
    expect(removeStreamerFromMap).not.toHaveBeenCalled();
    expect((conn as any).sessionId).toBe('sess-B');
    expect((conn as any).ws).not.toBeNull();
  });

  it('session_welcome (non-reconnecting): re-resolves a valid token before subscribing', async () => {
    vi.mocked(fetchValidEventSubToken).mockResolvedValueOnce('fresh-token');
    const conn = new StreamerConnection({ ...makeStreamerData(), token: 'expired-token' });
    await (conn as any).handleMessage(makeWelcomeMsg('sess-fresh'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-fresh', expect.objectContaining({ token: 'fresh-token' })));
    expect(fetchValidEventSubToken).toHaveBeenCalledWith(1);
  });

  it('session_welcome (non-reconnecting): keeps the existing token and still subscribes if the token lookup fails', async () => {
    vi.mocked(fetchValidEventSubToken).mockRejectedValueOnce(new Error('db down'));
    const conn = new StreamerConnection({ ...makeStreamerData(), token: 'old-token' });
    await (conn as any).handleMessage(makeWelcomeMsg('sess-err'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-err', expect.objectContaining({ token: 'old-token' })));
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to refresh EventSub token'), expect.any(Error));
  });

  it('session_welcome (non-reconnecting): keeps the existing token when the refresh resolves null', async () => {
    vi.mocked(fetchValidEventSubToken).mockResolvedValueOnce(null);
    const conn = new StreamerConnection({ ...makeStreamerData(), token: 'old-token' });
    await (conn as any).handleMessage(makeWelcomeMsg('sess-null'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-null', expect.objectContaining({ token: 'old-token' })));
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
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(1));
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

  it('the message listener parses the raw frame and dispatches it to handleMessage', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;

    ws.listeners.get('message')!({ data: JSON.stringify(makeWelcomeMsg('sess-from-socket')) } as any);

    await vi.waitFor(() =>
      expect(subscribeForStreamer).toHaveBeenCalledWith('sess-from-socket', expect.objectContaining({ uid: 'uid-123' })),
    );
  });

  it('the message listener logs and swallows a frame that is not valid JSON', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;

    expect(() => ws.listeners.get('message')!({ data: 'not json{' } as any)).not.toThrow();

    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Message parse error:'), expect.any(SyntaxError));
    expect(subscribeForStreamer).not.toHaveBeenCalled();
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

  it('stop() removes the streamer\'s health record entirely, rather than leaving it reported as disconnected', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();

    conn.stop();

    expect(removeEventSubHealth).toHaveBeenCalledWith('streamer');
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

  it('reconnects on a socket error even if no close event ever follows', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;

    firstWs.listeners.get('error')!();
    expect((conn as any).ws).toBeNull();
    expect((conn as any).reconnectAttempts).toBe(1);

    vi.advanceTimersByTime(1_000);
    const secondWs = (conn as any).ws as MockWebSocket;
    expect(secondWs).not.toBe(firstWs);

    // The stale socket's close event (if it ever arrives) must not affect the new connection.
    firstWs.listeners.get('close')!({ code: 1006, reason: 'abnormal' } as any);
    expect((conn as any).ws).toBe(secondWs);
  });

  it('ignores a stale open event from a socket already superseded by a force-reconnect', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;

    // Socket A errors and forceReconnect() tears it down, scheduling a reconnect.
    firstWs.listeners.get('error')!();
    expect((conn as any).reconnectAttempts).toBe(1);

    vi.advanceTimersByTime(1_000); // first reconnect attempt's backoff delay
    const secondWs = (conn as any).ws as MockWebSocket;
    expect(secondWs).not.toBe(firstWs);
    expect((conn as any).connectTimer).not.toBeNull(); // B's own connect timeout is armed

    // Socket A's 'open' now fires late — after it's already been superseded by B. Without the
    // this.ws !== socket guard, this would incorrectly clear B's connect timer and reset
    // reconnectAttempts/keepalive for a connection that hasn't actually opened yet.
    firstWs.listeners.get('open')!();
    expect((conn as any).reconnectAttempts).toBe(1);
    expect((conn as any).connectTimer).not.toBeNull();
    expect((conn as any).ws).toBe(secondWs);

    // B's own open then arrives for real and clears its connect timer. The reconnect backoff is
    // deliberately not reset on open — only once the session proves good (see the backoff tests).
    secondWs.listeners.get('open')!();
    expect((conn as any).reconnectAttempts).toBe(1);
    expect((conn as any).connectTimer).toBeNull();
  });

  it('keeps the reconnect backoff across a socket that opens but gets no live subscriptions, resetting it once one does', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0, 2));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    ((conn as any).ws as MockWebSocket).listeners.get('error')!();
    await vi.advanceTimersByTimeAsync(1_000);
    const ws = (conn as any).ws as MockWebSocket;
    ws.listeners.get('open')!();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-empty'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-empty', expect.anything()));
    await vi.advanceTimersByTimeAsync(0);
    // Every create failed transiently — Twitch will close this empty socket, and the next
    // reconnect must back off further rather than restart from 1s.
    expect((conn as any).reconnectAttempts).toBe(1);

    ws.listeners.get('close')!({ code: 4003, reason: 'connection unused' } as any);
    expect((conn as any).reconnectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect((conn as any).ws).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect((conn as any).ws).not.toBeNull();

    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(2));
    await (conn as any).handleMessage(makeWelcomeMsg('sess-good'));
    await vi.waitFor(() => expect((conn as any).reconnectAttempts).toBe(0));
  });

  it('keeps the connection and retries the subscribe step with backoff when creates fail transiently', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(0, 2)).mockResolvedValue(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-outage'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    expect(onSelfStop).not.toHaveBeenCalled();
    expect(removeStreamerFromMap).not.toHaveBeenCalled();
    expect((conn as any).ws).not.toBeNull();

    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('retrying in 5000ms'));
    expect(subscribeForStreamer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(2));
    expect(subscribeForStreamer).toHaveBeenLastCalledWith('sess-outage', expect.anything());
    await vi.waitFor(() => expect((conn as any).subscribeRetry.attempts).toBe(0));
    expect((conn as any).subscribeRetry.pending).toBe(false);
    expect(onSelfStop).not.toHaveBeenCalled();
  });

  it('logs (and does not throw) when a scheduled subscribe retry itself fails', async () => {
    vi.mocked(subscribeForStreamer)
      .mockResolvedValueOnce(outcome(0, 2))
      .mockRejectedValueOnce(new Error('helix down'))
      .mockResolvedValue(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-retry-err'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Subscribe retry error'), expect.any(Error),
    ));
    expect((conn as any).ws).not.toBeNull();
  });

  it('retries a partially-failed subscribe pass too, without stopping the connection', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(1, 1)).mockResolvedValue(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-partial'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(2));
  });

  it('bounds transient-failure subscribe retries with exponential backoff', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0, 1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    ((conn as any).ws as MockWebSocket).listeners.get('open')!(); // clears the connect timeout
    await (conn as any).handleMessage(makeWelcomeMsg('sess-down'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));

    // 5s, 10s, 20s, 40s, 80s, 160s, then capped at 300s — 8 retries in total.
    const delays = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
    for (const [i, delay] of delays.entries()) {
      await vi.waitFor(() => expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining(`retrying in ${delay}ms (attempt ${i + 1})`)));
      // Keep the keepalive watchdog from force-reconnecting during the long waits.
      (conn as any).clearKeepaliveTimer();
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(i + 2));
    }
    await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('giving up')));
    (conn as any).clearKeepaliveTimer();
    expect((conn as any).subscribeRetry.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(subscribeForStreamer).toHaveBeenCalledTimes(delays.length + 1);
    expect((conn as any).ws).not.toBeNull();
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('giving up'));
  });

  it('cancels a pending subscribe retry on stop()', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0, 1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-stop-retry'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    conn.stop();
    expect((conn as any).subscribeRetry.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscribeForStreamer).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending subscribe retry on reload(), which subscribes afresh itself', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(0, 1)).mockResolvedValue(outcome(1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-reload-retry'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    conn.reload(makeStreamerData());
    expect((conn as any).subscribeRetry.pending).toBe(false);
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(2));
    (conn as any).clearKeepaliveTimer();
    (conn as any).clearConnectTimer();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscribeForStreamer).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending subscribe retry when the socket is force-reconnected', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0, 1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-fr-retry'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    ((conn as any).ws as MockWebSocket).listeners.get('error')!();
    expect((conn as any).subscribeRetry.pending).toBe(false);
  });

  it('re-runs a fired subscribe retry on the migrated session when a migration lands while it awaits the token', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(1, 1)).mockResolvedValue(outcome(2));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-mig-a'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    // The retry fires and blocks on its token refresh.
    let resolveToken!: (token: string) => void;
    vi.mocked(fetchValidEventSubToken).mockReturnValueOnce(new Promise((resolve) => { resolveToken = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fetchValidEventSubToken).toHaveBeenCalledTimes(2));
    vi.mocked(subscribeForStreamer).mockClear();

    // A full session migration completes meanwhile.
    (conn as any).handleMessage(makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-mig-a', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=b' } },
    }));
    await (conn as any).handleMessage(makeWelcomeMsg('sess-mig-b'));
    resolveToken('token-abc');

    // The overtaken retry is carried over to the migrated session instead of being dropped.
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-mig-b', expect.anything()));
    expect(subscribeForStreamer).not.toHaveBeenCalledWith('sess-mig-a', expect.anything());
    await vi.waitFor(() => expect((conn as any).subscribeRetry.attempts).toBe(0));
  });

  it('logs (and does not throw) when a subscribe pass re-run on a migrated session fails', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(1, 1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-rerr-a'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    let resolveToken!: (token: string) => void;
    vi.mocked(fetchValidEventSubToken).mockReturnValueOnce(new Promise((resolve) => { resolveToken = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(fetchValidEventSubToken).toHaveBeenCalledTimes(2));

    (conn as any).handleMessage(makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-rerr-a', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=b' } },
    }));
    await (conn as any).handleMessage(makeWelcomeMsg('sess-rerr-b'));
    vi.mocked(subscribeForStreamer).mockRejectedValueOnce(new Error('helix down'));
    resolveToken('token-abc');

    await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('Migrated subscribe pass error'), expect.any(Error),
    ));
    expect((conn as any).ws).not.toBeNull();
  });

  it('defers a subscribe pass overtaken mid-flight by a migration still in progress to that migration\'s welcome', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValueOnce(outcome(1, 1));
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-def-a'));
    await vi.waitFor(() => expect((conn as any).subscribeRetry.pending).toBe(true));

    // The retry fires and blocks inside subscribeForStreamer.
    let resolveSubscribe!: (value: ReturnType<typeof outcome>) => void;
    vi.mocked(subscribeForStreamer).mockReturnValueOnce(new Promise((resolve) => { resolveSubscribe = resolve; }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(2));

    // Migration to B completes, then a second migration (to C) starts before the pass resolves.
    const reconnectTo = (from: string, to: string) => makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: from, keepalive_timeout_seconds: 10, reconnect_url: `wss://eventsub.wss.twitch.tv/ws?session_id=${to}` } },
    });
    (conn as any).handleMessage(reconnectTo('sess-def-a', 'b'));
    await (conn as any).handleMessage(makeWelcomeMsg('sess-def-b'));
    (conn as any).handleMessage(reconnectTo('sess-def-b', 'c'));
    vi.mocked(subscribeForStreamer).mockClear();
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(2));
    resolveSubscribe(outcome(1, 1));
    await vi.waitFor(() => expect((conn as any).reloadPendingAfterMigration).toBe(true));
    expect(subscribeForStreamer).not.toHaveBeenCalled();

    await (conn as any).handleMessage(makeWelcomeMsg('sess-def-c'));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-def-c', expect.anything()));
    expect((conn as any).reloadPendingAfterMigration).toBe(false);
  });

  it('still self-stops when every failure was an auth/scope failure (nothing transient to retry)', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0, 0, 3));
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-auth'));
    await vi.waitFor(() => expect(onSelfStop).toHaveBeenCalledWith('uid-123'));
    expect((conn as any).subscribeRetry.pending).toBe(false);
  });

  it('self-stops when nothing is desired', async () => {
    vi.mocked(subscribeForStreamer).mockResolvedValue({ desired: 0, live: 0, transientFailures: 0 });
    const conn = new StreamerConnection(makeStreamerData());
    const onSelfStop = vi.fn();
    conn.setSelfStopCallback(onSelfStop);
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-nothing'));
    await vi.waitFor(() => expect(onSelfStop).toHaveBeenCalledWith('uid-123'));
  });

  it('tears down the current socket when session_reconnect carries an invalid reconnect_url', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const ws = (conn as any).ws as MockWebSocket;
    (conn as any).handleMessage(makeWelcomeMsg('sess-bad-url'));

    (conn as any).handleMessage(makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-bad-url', keepalive_timeout_seconds: 10, reconnect_url: 'wss://evil.example.com/ws' } },
    }));

    expect(ws.close).toHaveBeenCalled();
    expect((conn as any).ws).toBeNull();
    expect((conn as any).sessionId).toBeNull();
    expect((conn as any).reconnectTimer).not.toBeNull();
    // The torn-down socket's late close event must not schedule a second reconnect.
    ws.listeners.get('close')!({ code: 1000, reason: '' } as any);
    expect((conn as any).reconnectAttempts).toBe(1);
  });

  it('reconnects if the WebSocket never leaves CONNECTING (no open/error/close ever fires)', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;

    // Simulates a TCP handshake that hangs silently (e.g. a firewall/NAT drop) rather than
    // failing outright — none of 'open', 'error', or 'close' ever fires on their own.
    vi.advanceTimersByTime(30_000); // CONNECT_TIMEOUT_MS
    expect(firstWs.close).toHaveBeenCalled();
    expect((conn as any).ws).toBeNull();
    expect((conn as any).reconnectAttempts).toBe(1);

    vi.advanceTimersByTime(1_000); // first reconnect attempt's backoff delay
    const secondWs = (conn as any).ws as MockWebSocket;
    expect(secondWs).not.toBeNull();
    expect(secondWs).not.toBe(firstWs);
  });

  it('clears the connect timeout once the socket has already opened, so it cannot fire later', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    expect((conn as any).connectTimer).not.toBeNull();

    const ws = (conn as any).ws as MockWebSocket;
    ws.listeners.get('open')!();

    // If the connect timeout weren't cleared here, it would fire at 30s and force-reconnect
    // a socket that's already open and working — this proves it can't, independent of the
    // keepalive timer (which is a separate 20s mechanism also armed by open()).
    expect((conn as any).connectTimer).toBeNull();
  });

  /** Verifies a watchdog-triggered (keepalive-timeout) forceReconnect records the connection as disconnected, not just the error/close handlers. */
  it('records disconnected health state on a keepalive-timeout-triggered reconnect', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;
    firstWs.listeners.get('open')!();
    vi.mocked(recordEventSubConnected).mockClear(); // clear the onOpen(true) call above

    vi.advanceTimersByTime(20_000); // keepalive timeout fires, triggering forceReconnect directly

    expect(recordEventSubConnected).toHaveBeenCalledWith('streamer', false);
  });

  /** Verifies the keepalive-timeout path force-reconnects without waiting on the socket's own 'close' event; returns void. */
  it('reconnects on a keepalive timeout even if the socket never fires its own close event', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;
    firstWs.listeners.get('open')!();

    // Default keepaliveTimeoutSecs is 10 (set in the constructor, before any session_welcome
    // sets a Twitch-provided value), so the timer fires after (10 + 10) * 1000ms.
    vi.advanceTimersByTime(20_000);
    expect(firstWs.close).toHaveBeenCalledWith(4000, 'keepalive timeout');

    vi.advanceTimersByTime(1_000); // first reconnect attempt's backoff delay
    // Reconnected without the mock socket ever invoking its 'close' listener — this is the
    // half-dead-connection scenario a real close() call can silently never resolve.
    const secondWs = (conn as any).ws as MockWebSocket;
    expect(secondWs).not.toBeNull();
    expect(secondWs).not.toBe(firstWs);
    expect((conn as any).reconnectAttempts).toBe(1);
  });

  /** Verifies a stale close event arriving after a keepalive-triggered reconnect is ignored; returns void. */
  it('ignores a late close event from a socket already superseded by a keepalive-triggered reconnect', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws as MockWebSocket;
    firstWs.listeners.get('open')!();

    vi.advanceTimersByTime(20_000); // keepalive timeout fires
    vi.advanceTimersByTime(1_000); // first reconnect attempt's backoff delay
    const secondWs = (conn as any).ws as MockWebSocket;

    // The first socket's close() eventually does fire its 'close' listener, late.
    firstWs.listeners.get('close')!({ code: 4000, reason: 'keepalive timeout' } as any);

    expect((conn as any).ws).toBe(secondWs); // unaffected by the stale event
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

  it('reload() does not open a second WebSocket when a connect() is already in flight (session_welcome not yet received)', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstWs = (conn as any).ws;
    expect(firstWs).toBeTruthy();
    // this.ws is set (start()'s connect() already ran) but this.sessionId is still null —
    // session_welcome hasn't arrived yet. Without the fix, doReload() would call connect()
    // again here, opening a second live WebSocket alongside the first.
    expect((conn as any).sessionId).toBeNull();
    const connectSpy = vi.spyOn(conn, 'connect');

    const updatedData = { ...makeStreamerData(), name: 'updated-streamer' };
    conn.reload(updatedData);

    // Flush the reload chain's microtasks — doReload() must take its early-return branch
    // rather than calling connect() a second time.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectSpy).not.toHaveBeenCalled();
    expect((conn as any).ws).toBe(firstWs);

    // The still-pending connect's own session_welcome now arrives — it must subscribe using
    // reload()'s updated data (currentData was already reassigned synchronously), proving
    // nothing was lost by not opening a second connection. The subscribe itself runs via
    // reloadChain's own .then() (not awaited by handleMessage), so it settles a tick later.
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));
    await vi.waitFor(() => {
      expect(subscribeForStreamer).toHaveBeenCalledWith('sess-live', expect.objectContaining({ name: 'updated-streamer' }));
    });
  });

  it('reload() re-subscribes on the live session and stops when no subscriptions remain', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));
    vi.mocked(subscribeForStreamer).mockResolvedValue(outcome(0));

    conn.reload(makeStreamerData());
    await vi.waitFor(() => expect(removeStreamerFromMap).toHaveBeenCalled());

    expect(subscribeForStreamer).toHaveBeenCalledWith('sess-live', expect.objectContaining({ uid: 'uid-123' }));
  });

  it('closes the old socket once the migration-close delay elapses after a session reconnect', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const oldWs = (conn as any).ws as MockWebSocket;

    const reconnectMsg = makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new' } },
    });
    (conn as any).handleMessage(reconnectMsg);
    expect((conn as any).migrationCloseTimer).not.toBeNull();
    expect(oldWs.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);

    expect(oldWs.close).toHaveBeenCalledWith(1000, 'reconnect');
    expect((conn as any).migrationCloseTimer).toBeNull();
  });

  it('cancels the pending migration-close timer on stop() and closes the old socket with a shutdown reason instead', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const oldWs = (conn as any).ws as MockWebSocket;

    const reconnectMsg = makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new' } },
    });
    (conn as any).handleMessage(reconnectMsg);
    expect((conn as any).migrationCloseTimer).not.toBeNull();

    conn.stop();
    expect((conn as any).migrationCloseTimer).toBeNull();
    expect(oldWs.close).toHaveBeenCalledWith(1000, 'shutdown');
    expect(oldWs.close).not.toHaveBeenCalledWith(1000, 'reconnect');

    oldWs.close.mockClear();
    vi.advanceTimersByTime(5_000);
    // The timer stop() cancelled must not fire later and close the socket a second time.
    expect(oldWs.close).not.toHaveBeenCalled();
  });

  it('closes the previous pending old socket immediately when a second session_reconnect arrives before the first delay elapses', () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    const firstOldWs = (conn as any).ws as MockWebSocket;

    (conn as any).handleMessage(makeMsg({
      message_type: 'session_reconnect',
      message_id: 'reconnect-1',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new1' } },
    }));
    const secondOldWs = (conn as any).ws as MockWebSocket;
    expect(secondOldWs).not.toBe(firstOldWs);
    const firstTimer = (conn as any).migrationCloseTimer;

    vi.advanceTimersByTime(2_000);

    // A second, distinct session_reconnect arrives before the first migration-close timer fires.
    (conn as any).handleMessage(makeMsg({
      message_type: 'session_reconnect',
      message_id: 'reconnect-2',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new2' } },
    }));

    // The first old socket is closed immediately rather than left on an orphaned timer.
    expect(firstOldWs.close).toHaveBeenCalledWith(1000, 'reconnect');
    const secondTimer = (conn as any).migrationCloseTimer;
    expect(secondTimer).not.toBe(firstTimer);

    // Advancing past the first timer's original 5s deadline must not fire the orphaned timer
    // (which would otherwise null out migrationCloseTimer and close secondOldWs early/twice).
    vi.advanceTimersByTime(3_000); // t=5s from reconnect-1
    expect(secondOldWs.close).not.toHaveBeenCalled();
    expect((conn as any).migrationCloseTimer).toBe(secondTimer);

    vi.advanceTimersByTime(2_000); // t=5s from reconnect-2
    expect(secondOldWs.close).toHaveBeenCalledWith(1000, 'reconnect');
    expect((conn as any).migrationCloseTimer).toBeNull();
  });

  it('defers a reload() issued mid-session-migration and applies it once the new session welcomes', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-old'));
    // Let the welcome's own (token-refresh-then-subscribe) chain land before measuring the reload.
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledWith('sess-old', expect.anything()));

    // Enter the migration window: session_reconnect swaps in a new socket, but sessionId
    // is still 'sess-old' until the new session's welcome arrives.
    const reconnectMsg = makeMsg({
      message_type: 'session_reconnect',
      payload: { session: { id: 'sess-old', keepalive_timeout_seconds: 10, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?session_id=new' } },
    });
    (conn as any).handleMessage(reconnectMsg);
    expect((conn as any).isReconnecting).toBe(true);
    expect((conn as any).sessionId).toBe('sess-old');

    vi.mocked(subscribeForStreamer).mockClear();

    // A config reload comes in during the migration window.
    conn.reload(makeStreamerData());
    await vi.waitFor(() => expect((conn as any).reloadPendingAfterMigration).toBe(true));

    // The stale old session id must NOT be subscribed against.
    expect(subscribeForStreamer).not.toHaveBeenCalled();

    // The new session's welcome now arrives, completing the migration.
    await (conn as any).handleMessage(makeWelcomeMsg('sess-new'));

    // The deferred reload is applied against the new, correct session id, via reloadChain —
    // so the subscribe call happens asynchronously and must be awaited.
    await vi.waitFor(() => {
      expect(subscribeForStreamer).toHaveBeenCalledWith('sess-new', expect.objectContaining({ uid: 'uid-123' }));
      expect(subscribeForStreamer).not.toHaveBeenCalledWith('sess-old', expect.anything());
    });
    expect((conn as any).reloadPendingAfterMigration).toBe(false);
  });

  it('serialises overlapping reload() calls through the reload chain', async () => {
    const conn = new StreamerConnection(makeStreamerData());
    conn.start();
    await (conn as any).handleMessage(makeWelcomeMsg('sess-live'));
    // The welcome handshake's own subscribe now also runs through reloadChain, so wait
    // for it to land before measuring the reload() calls in isolation.
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));
    vi.mocked(subscribeForStreamer).mockClear();

    // First reload's subscribeForStreamer call stays pending until resolveFirst() fires,
    // so we can prove the second reload's call doesn't start until the first one settles.
    let resolveFirst!: (value: ReturnType<typeof outcome>) => void;
    const firstDeferred = new Promise<ReturnType<typeof outcome>>((resolve) => { resolveFirst = resolve; });
    vi.mocked(subscribeForStreamer)
      .mockImplementationOnce(() => firstDeferred)
      .mockResolvedValueOnce(outcome(1));

    conn.reload(makeStreamerData());
    conn.reload(makeStreamerData());

    // The first reload's call fires once its turn in reloadChain comes up.
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(1));
    // The second reload is chained behind the first's still-unresolved promise, so it
    // structurally cannot fire until resolveFirst() settles it — flushing extra
    // microtasks here proves it's stuck, not just slow to start.
    await Promise.resolve();
    await Promise.resolve();
    expect(subscribeForStreamer).toHaveBeenCalledTimes(1);

    resolveFirst(outcome(1));
    await vi.waitFor(() => expect(subscribeForStreamer).toHaveBeenCalledTimes(2));
  });
});
