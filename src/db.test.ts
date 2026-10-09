import { describe, it, expect, vi } from 'vitest';
import { mockLogger } from './test-utils/loggerMock';

// The facade loads every DB module; `shared/config` throws on missing env vars at import time,
// and only `EVENTSUB_TOKEN_SECRET` is read by DB modules other than the (mocked) pool.
vi.mock('./shared/config', () => ({ EVENTSUB_TOKEN_SECRET: 'test' }));
vi.mock('./shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./db/pool', () => ({ getPool: vi.fn(), closePool: vi.fn() }));

import * as db from './db';
import * as userWrites from './db/userWrites';
import * as guildCommandOverrideWrites from './db/guildCommandOverrideWrites';
import * as customCommandWrites from './db/customCommandWrites';
import * as counterWrites from './db/counterWrites';
import * as alertConfigWrites from './db/alertConfigWrites';
import * as sfxWrites from './db/sfxWrites';
import { pingDb } from './db/health';

// The facade must hand out the cache-invalidating wrappers, never the raw DB-module writes of
// the same name — re-exporting e.g. `addCounter` from './db/counters' would silently skip
// invalidation. The wrappers' own behaviour is tested in each `db/*Writes.test.ts`.
describe('db facade', () => {
  it.each([
    ['userWrites', userWrites],
    ['guildCommandOverrideWrites', guildCommandOverrideWrites],
    ['customCommandWrites', customCommandWrites],
    ['counterWrites', counterWrites],
    ['alertConfigWrites', alertConfigWrites],
    ['sfxWrites', sfxWrites],
  ])('re-exports every %s wrapper', (_name, writes) => {
    const entries = Object.entries(writes);
    expect(entries.length).toBeGreaterThan(0);
    for (const [exportName, wrapper] of entries) {
      expect(db[exportName as keyof typeof db], exportName).toBe(wrapper);
    }
  });

  it('re-exports pingDb from db/health', () => {
    expect(db.pingDb).toBe(pingDb);
  });
});
