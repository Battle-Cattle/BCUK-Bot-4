import type { Request } from 'express';
import { ipKey } from '../rateLimits';

// A connection sub-pool with its own total and per-IP limits, carved out of the process-wide SSE
// cap. Generic: `sseChannel.ts` enforces it for any SSE endpoint that passes one, and
// `sseOverlayAccess.ts` defines the one the unauthenticated overlay endpoints share.

/**
 * A sub-pool of the process-wide cap with its own total and per-IP limits, for SSE endpoints
 * that anyone can open without authenticating (the OBS browser-source overlays). Keeps those
 * callers from consuming the slots the authenticated streams (companion, dashboard, health,
 * settings status) rely on, and stops a single IP from taking the whole sub-pool.
 */
export interface SseConnectionPool {
  /** Maximum concurrent connections across the whole pool. */
  readonly maxConnections: number;
  /** Maximum concurrent connections in the pool from any one client IP (see `ipKey`). */
  readonly maxPerIp: number;
  /** Current number of connections attached under this pool. */
  count: number;
  /** Current connection count per client IP key; entries are deleted when they reach zero. */
  readonly byIp: Map<string, number>;
}

/**
 * Creates an empty {@link SseConnectionPool}.
 * @param maxConnections - Pool-wide concurrent connection limit.
 * @param maxPerIp - Per-client-IP concurrent connection limit within the pool.
 * @returns A new pool with no connections counted.
 */
export function createSseConnectionPool(maxConnections: number, maxPerIp: number): SseConnectionPool {
  return { maxConnections, maxPerIp, count: 0, byIp: new Map() };
}

/**
 * Claims one slot in `pool` for the request's client IP, if both the pool-wide and per-IP limits
 * have room.
 * @param pool - The sub-pool to reserve in.
 * @param req - Express request; its client IP (see `ipKey`) keys the per-IP limit.
 * @returns The IP key the slot was counted under (pass it to {@link releasePoolSlot}), or null if
 *   a limit was already reached and nothing was reserved.
 */
export function tryReservePoolSlot(pool: SseConnectionPool, req: Request): string | null {
  const ip = ipKey(req);
  const perIp = pool.byIp.get(ip) ?? 0;
  if (pool.count >= pool.maxConnections || perIp >= pool.maxPerIp) return null;
  pool.count++;
  pool.byIp.set(ip, perIp + 1);
  return ip;
}

/**
 * Releases a slot claimed by {@link tryReservePoolSlot}, dropping the IP's entry at zero.
 * @param pool - The sub-pool the slot was reserved in.
 * @param ip - The IP key returned by {@link tryReservePoolSlot}.
 */
export function releasePoolSlot(pool: SseConnectionPool, ip: string): void {
  pool.count--;
  const remaining = (pool.byIp.get(ip) ?? 1) - 1;
  if (remaining > 0) pool.byIp.set(ip, remaining);
  else pool.byIp.delete(ip);
}
