import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

// Per-connection nonces for the shared overlay's readiness reports (#1052). The overlay URL carries
// no credential (OBS can't log in, and links must stay as they are), so the server hands each SSE
// connection a random nonce in its `init` frame, and `/report` accepts only a nonce held by a
// connection that is still open for that login. Keyed weakly by the connection, so a closed one's
// nonce goes with it and nothing needs cleaning up.

/** Header the overlay page sends its nonce in. */
export const REPORT_NONCE_HEADER = 'x-shared-overlay-nonce';

/** Random bytes per nonce (sent as 64 hex characters). */
const NONCE_BYTES = 32;

/** Matches a well-formed nonce, so anything else is refused before comparing. */
const NONCE_RE = /^[0-9a-f]{64}$/;

const nonces = new WeakMap<Response, Buffer>();

/**
 * Gives a shared overlay connection a fresh nonce, replacing any it had.
 * @param res - The overlay's SSE response.
 * @returns The nonce as hex, to send in the connection's `init` frame.
 */
export function issueReportNonce(res: Response): string {
  const nonce = randomBytes(NONCE_BYTES);
  nonces.set(res, nonce);
  return nonce.toString('hex');
}

/**
 * Checks a submitted nonce against the open connections of one login, in constant time per connection.
 * @param submitted - The untrusted nonce from the report request.
 * @param connections - The login's open shared overlay connections (undefined when it has none).
 * @returns True only when one of those connections holds exactly this nonce.
 */
export function isLiveReportNonce(submitted: unknown, connections: Iterable<Response> | undefined): boolean {
  if (typeof submitted !== 'string' || !NONCE_RE.test(submitted) || !connections) return false;
  const incoming = Buffer.from(submitted, 'hex');
  for (const res of connections) {
    const held = nonces.get(res);
    if (held && timingSafeEqual(held, incoming)) return true;
  }
  return false;
}
