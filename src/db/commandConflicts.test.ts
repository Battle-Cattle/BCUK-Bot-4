import { describe, it, expect, vi } from 'vitest';

vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));

import {
  assertDiscordTriggerAvailable,
  assertMultiTwitchTriggerAvailable,
  assertNoSingleTwitchAssignmentOverlap,
  assertNoTwitchChannelTriggerConflict,
} from './commandConflicts';
import { CommandConflictError } from './commandErrors';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool/executor resolving `execute`/`query` to the given rows. */
// Cast to any to satisfy SqlExecutor (Pool | PoolConnection) without importing full mysql types
function makeExecutor(rows: unknown[] = []): any {
  return makeMockPool({ rows });
}

// ─── assertDiscordTriggerAvailable ───────────────────────────────────────────

describe('assertDiscordTriggerAvailable', () => {
  it('does not throw when no conflict rows returned', async () => {
    const exec = makeExecutor([]);
    await expect(assertDiscordTriggerAvailable('!test', exec)).resolves.not.toThrow();
  });

  it('throws CommandConflictError when a conflict row is found', async () => {
    const exec = makeExecutor([{ command_id: 1 }]);
    await expect(assertDiscordTriggerAvailable('!test', exec)).rejects.toBeInstanceOf(CommandConflictError);
  });

  it('includes the trigger string in the conflict error', async () => {
    const exec = makeExecutor([{ command_id: 1 }]);
    await expect(assertDiscordTriggerAvailable('!test', exec)).rejects.toMatchObject({
      commands: expect.arrayContaining(['!test']),
    });
  });

  it('adds AND command_id <> ? clause when excludeCommandId is provided', async () => {
    const exec = makeExecutor([]);
    await assertDiscordTriggerAvailable('!test', exec, 42);
    const sql: string = exec.execute.mock.calls[0][0];
    expect(sql).toContain('command_id <> ?');
    expect(exec.execute.mock.calls[0][1]).toContain(42);
  });

  it('does not add exclude clause when excludeCommandId is undefined', async () => {
    const exec = makeExecutor([]);
    await assertDiscordTriggerAvailable('!test', exec);
    const sql: string = exec.execute.mock.calls[0][0];
    expect(sql).not.toContain('command_id <> ?');
  });
});

// ─── assertMultiTwitchTriggerAvailable ───────────────────────────────────────

describe('assertMultiTwitchTriggerAvailable', () => {
  it('does not throw when no multi-twitch conflict', async () => {
    const exec = makeExecutor([]);
    await expect(assertMultiTwitchTriggerAvailable(exec, '!test')).resolves.not.toThrow();
  });

  it('throws CommandConflictError when a multi-twitch conflict exists', async () => {
    const exec = makeExecutor([{ command_id: 5 }]);
    await expect(assertMultiTwitchTriggerAvailable(exec, '!test')).rejects.toBeInstanceOf(CommandConflictError);
  });

  it('uses exclude clause when excludeCommandId is provided', async () => {
    const exec = makeExecutor([]);
    await assertMultiTwitchTriggerAvailable(exec, '!test', 7);
    const sql: string = exec.execute.mock.calls[0][0];
    expect(sql).toContain('c.command_id <> ?');
    expect(exec.execute.mock.calls[0][1]).toContain(7);
  });

  it('does not use exclude clause when no excludeCommandId', async () => {
    const exec = makeExecutor([]);
    await assertMultiTwitchTriggerAvailable(exec, '!test');
    const sql: string = exec.execute.mock.calls[0][0];
    expect(sql).not.toContain('c.command_id <> ?');
  });
});

// ─── assertNoSingleTwitchAssignmentOverlap ────────────────────────────────────

describe('assertNoSingleTwitchAssignmentOverlap', () => {
  it('does not throw when no overlap rows returned', async () => {
    const exec = makeExecutor([]);
    await expect(assertNoSingleTwitchAssignmentOverlap(exec, 1, '!test')).resolves.not.toThrow();
  });

  it('throws CommandConflictError when overlap exists', async () => {
    const exec = makeExecutor([{ command_id: 2 }]);
    await expect(assertNoSingleTwitchAssignmentOverlap(exec, 1, '!test')).rejects.toBeInstanceOf(CommandConflictError);
  });
});

// ─── assertNoTwitchChannelTriggerConflict ─────────────────────────────────────

describe('assertNoTwitchChannelTriggerConflict', () => {
  it('does not throw when no conflict', async () => {
    const exec = makeExecutor([]);
    await expect(assertNoTwitchChannelTriggerConflict(exec, 1, '!test', ['alice'])).resolves.not.toThrow();
  });

  it('throws CommandConflictError when conflict found', async () => {
    const exec = makeExecutor([{ command_id: 3 }]);
    await expect(assertNoTwitchChannelTriggerConflict(exec, 1, '!test', ['alice'])).rejects.toBeInstanceOf(CommandConflictError);
  });

  it('passes commandId, triggerString, and normalizedTwitchName to the query', async () => {
    const exec = makeExecutor([]);
    await assertNoTwitchChannelTriggerConflict(exec, 10, '!clap', ['alice']);
    const params: unknown[] = exec.execute.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain('!clap');
    expect(params).toContain('alice');
  });

  it('matches every given Twitch name in one query', async () => {
    const exec = makeExecutor([]);
    await assertNoTwitchChannelTriggerConflict(exec, 10, '!clap', ['alice', 'bob']);
    expect(exec.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = exec.execute.mock.calls[0];
    expect(sql).toContain('u.twitch_name IN (?, ?)');
    expect(params).toEqual([10, '!clap', 'alice', 'bob']);
  });
});
