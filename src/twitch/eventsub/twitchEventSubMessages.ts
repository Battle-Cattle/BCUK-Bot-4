import { createLogger } from '../../shared/logger';
import { dispatchNotification, handleRevocation } from './twitchEventSubSubscriptions';

// Connection-independent handling of EventSub WebSocket messages: the message types, the
// reconnect-URL allowlist, process-wide message-id dedup and staleness checks, and routing a
// message to its handler. Used by StreamerConnection (twitchEventSubConnection.ts).

const log = createLogger('EventSub');

/** How long a message ID is remembered for deduplication (ms). */
export const MESSAGE_TTL_MS = 10 * 60 * 1000;

/** Metadata fields present on every EventSub WebSocket message. */
export interface EventSubMetadata {
  message_type: string;
  message_id: string;
  message_timestamp: string;
}

/** A single EventSub WebSocket message. */
export interface EventSubMessage {
  metadata: EventSubMetadata;
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number; reconnect_url?: string | null };
    subscription?: { type: string; status: string; condition: Record<string, string> };
    event?: Record<string, unknown>;
  };
}

/** Validates the Twitch-supplied reconnect URL against a strict allowlist. */
export function buildReconnectUrl(reconnectUrl: string): string | null {
  let parsed: URL;
  try { parsed = new URL(reconnectUrl); } catch { return null; }
  const validPorts = new Set(['', '443']);
  const checkResults = {
    protocol: parsed.protocol === 'wss:',
    hostname: parsed.hostname === 'eventsub.wss.twitch.tv' || parsed.hostname.endsWith('.eventsub.wss.twitch.tv'),
    username: !parsed.username,
    password: !parsed.password,
    port: validPorts.has(parsed.port),
    pathname: parsed.pathname.replace(/\/$/, '') === '/ws',
  };
  const failed = Object.entries(checkResults).filter(([, v]) => !v).map(([k]) => k);
  if (failed.length > 0) {
    log.error(`Invalid reconnect URL — failed checks: ${failed.join(', ')} — url: ${reconnectUrl}`);
    return null;
  }
  // Reconstruct from validated components so taint analysis sees a clean value
  const safe = new URL(`wss://${parsed.hostname}/ws`);
  safe.search = parsed.search;
  return safe.href;
}

/** Manages a per-streamer EventSub WebSocket connection with reconnection and keepalive logic. */

// TTL-based dedup: messageId → expiry timestamp (shared across all per-streamer connections)
export const seenMessageIds = new Map<string, number>();

/** Removes all expired entries from the deduplication map. */
export function purgeExpiredMessageIds(): void {
  const now = Date.now();
  for (const [id, expiry] of seenMessageIds) {
    if (expiry < now) seenMessageIds.delete(id);
  }
}

// Purge expired entries on a fixed interval so isDuplicate stays O(1).
setInterval(purgeExpiredMessageIds, MESSAGE_TTL_MS).unref();

/** Returns true if messageId has been seen within MESSAGE_TTL_MS; records it otherwise. */
export function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  const expiry = seenMessageIds.get(messageId);
  if (expiry !== undefined && now <= expiry) return true;
  seenMessageIds.set(messageId, now + MESSAGE_TTL_MS);
  return false;
}

/** Returns true if the ISO timestamp is older than MESSAGE_TTL_MS or unparseable. */
export function isStale(timestamp: string): boolean {
  const ts = Date.parse(timestamp);
  return !Number.isFinite(ts) || Date.now() - ts > MESSAGE_TTL_MS;
}

/**
 * Says why a message should be ignored, if at all. Checks staleness before recording the id for
 * dedup, so a stale message never claims an id.
 * @param messageId - The message's `metadata.message_id`.
 * @param timestamp - The message's `metadata.message_timestamp`.
 * @returns `'Stale'` or `'Duplicate'` if the message should be ignored, otherwise null.
 */
export function rejectionReason(messageId: string, timestamp: string): 'Stale' | 'Duplicate' | null {
  if (isStale(timestamp)) return 'Stale';
  if (isDuplicate(messageId)) return 'Duplicate';
  return null;
}

/** Connection-specific handlers {@link routeEventSubMessage} calls for session messages. */
export interface SessionMessageHandlers {
  /** Called with a `session_welcome` message. */
  onWelcome: (msg: EventSubMessage) => void;
  /** Called with the `reconnect_url` of a `session_reconnect` message that carries one. */
  onReconnect: (reconnectUrl: string) => void;
}

/**
 * Routes one (already fresh and de-duplicated) message by `metadata.message_type`: session
 * messages to `handlers`, notifications to `dispatchNotification`, and revocations to
 * `handleRevocation`. Keepalives and unknown types need nothing here.
 * @param msg - The parsed EventSub message.
 * @param handlers - The connection's session-message handlers.
 */
export function routeEventSubMessage(msg: EventSubMessage, handlers: SessionMessageHandlers): void {
  const { subscription: sub, event, session } = msg.payload;
  switch (msg.metadata.message_type) {
    case 'session_welcome':
      handlers.onWelcome(msg);
      break;
    case 'session_reconnect':
      if (session?.reconnect_url) handlers.onReconnect(session.reconnect_url);
      break;
    case 'notification':
      if (sub && event) dispatchNotification(sub.type, event, sub.condition);
      break;
    case 'revocation':
      if (sub) handleRevocation(sub);
      break;
  }
}
