import { describe, it, expect } from 'vitest';
import { createSseConnectionPool, tryReservePoolSlot, releasePoolSlot } from './sseConnectionPool';

describe('tryReservePoolSlot / releasePoolSlot', () => {
  const reqFrom = (ip: string) => ({ ip, socket: { remoteAddress: ip } }) as any;

  it('reserves under the pool and per-IP limits and releases back to empty', () => {
    const pool = createSseConnectionPool(3, 2);
    const ip = tryReservePoolSlot(pool, reqFrom('1.1.1.1'));
    expect(ip).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('1.1.1.1'))).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('1.1.1.1'))).toBeNull(); // per-IP limit
    expect(tryReservePoolSlot(pool, reqFrom('2.2.2.2'))).not.toBeNull();
    expect(tryReservePoolSlot(pool, reqFrom('3.3.3.3'))).toBeNull(); // pool limit
    expect(pool.count).toBe(3);
    releasePoolSlot(pool, ip!);
    expect(pool.count).toBe(2);
    expect(pool.byIp.get(ip!)).toBe(1);
  });

  it('drops an IP entry once its count reaches zero', () => {
    const pool = createSseConnectionPool(3, 2);
    const ip = tryReservePoolSlot(pool, reqFrom('1.1.1.1'))!;
    releasePoolSlot(pool, ip);
    expect(pool.byIp.has(ip)).toBe(false);
    expect(pool.count).toBe(0);
  });
});
