import { getPool } from './pool';

/**
 * Verifies DB connectivity by acquiring a pooled connection and pinging it, mirroring the
 * check `index.ts`'s startup sequence already performs. Deliberately doesn't touch
 * `healthStore` itself — callers (e.g. the periodic health-check interval in `index.ts`)
 * record the outcome, keeping this module free of any dependency on `shared/healthStore`.
 * The connection is always released back to the pool once acquired, even if the ping itself
 * throws — otherwise a failing ping would leak a pooled connection on every failure.
 * @returns true if the ping succeeded, false if acquiring a connection or pinging it failed.
 */
export async function pingDb(): Promise<boolean> {
  let conn;
  try {
    conn = await getPool().getConnection();
  } catch {
    return false;
  }
  try {
    await conn.ping();
    return true;
  } catch {
    return false;
  } finally {
    conn.release();
  }
}
