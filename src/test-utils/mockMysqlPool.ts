import { vi, type Mock } from 'vitest';

/** A hand-rolled fake of a mysql2 `PoolConnection`, covering the subset used across `src/db/*.test.ts`. */
export interface MockConnection {
  execute: Mock;
  beginTransaction: Mock;
  commit: Mock;
  rollback: Mock;
  release: Mock;
}

/**
 * Builds a fake mysql2 `PoolConnection`. `execute` resolves to `[[], []]` by
 * default — override it (or pass `overrides.execute`) with
 * `mockResolvedValue`/`mockResolvedValueOnce` for specific row/result data.
 * `beginTransaction`/`commit`/`rollback` resolve to `undefined`; `release` is a
 * plain spy. Pass `overrides` to replace any field wholesale.
 */
export function makeMockConnection(overrides: Partial<MockConnection> = {}): MockConnection {
  return {
    execute: vi.fn().mockResolvedValue([[], []]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    ...overrides,
  };
}

/** A hand-rolled fake of a mysql2 `Pool`, covering the subset used across `src/db/*.test.ts`. */
export interface MockPool {
  execute: Mock;
  query: Mock;
  getConnection: Mock;
  /** The fake connection `getConnection()` resolves to — assert on it directly, e.g. `pool._conn.commit`. */
  _conn: MockConnection;
}

export interface MakeMockPoolOptions {
  /** Rows resolved by `execute`/`query` when no `executeResult` override is given. Defaults to `[]`. */
  rows?: unknown[];
  /** The metadata/field-packet half of the `execute`/`query` result tuple. Defaults to `[]`. */
  meta?: unknown;
  /**
   * Full `[result, meta]` (or ResultSetHeader-shaped `[header, meta]`) tuple to resolve
   * `execute`/`query` with, bypassing the `rows`/`meta` wrapping. Use this for INSERT/UPDATE/DELETE
   * results (`insertId`/`affectedRows`) or for pre-built row tuples like `[[row]]`.
   */
  executeResult?: unknown;
  /** Fake connection returned by `getConnection()`. Defaults to a fresh `makeMockConnection()`. */
  connection?: MockConnection;
}

/**
 * Builds a fake mysql2 `Pool` covering the shapes used across `src/db/*.test.ts`: a top-level
 * `execute`/`query` resolving to row data, and `getConnection()` resolving to a fake transactional
 * connection (also exposed as `_conn` for direct assertions, e.g. `pool._conn.commit`).
 */
export function makeMockPool(options: MakeMockPoolOptions = {}): MockPool {
  const { rows = [], meta = [], executeResult, connection } = options;
  const result = executeResult !== undefined ? executeResult : [[...rows], meta];
  const conn = connection ?? makeMockConnection();
  return {
    execute: vi.fn().mockResolvedValue(result),
    query: vi.fn().mockResolvedValue(result),
    getConnection: vi.fn().mockResolvedValue(conn),
    _conn: conn,
  };
}
