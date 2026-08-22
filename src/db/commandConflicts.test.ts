import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./pool', () => ({ getPool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ default: {} }));
vi.mock('../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((s: string) => (s ? s.toLowerCase() : null)),
}));
vi.mock('./commandLocks', () => {
  const isDeadlockError = vi.fn().mockReturnValue(false);
  const MAX_DEADLOCK_RETRIES = 3;
  // Faithful re-implementation of the real runWithDeadlockRetry (commandLocks.ts), wired to
  // this factory's own isDeadlockError/MAX_DEADLOCK_RETRIES mocks so tests can drive retry
  // behavior by queuing isDeadlockError return values, same as they did before this helper
  // was extracted out of commandConflicts.ts.
  const runWithDeadlockRetry = vi.fn(async (connection: any, retryLogLabel: string, body: (attempt: number) => Promise<unknown>, exhaustedErrorMessage?: string) => {
    for (let attempt = 0; attempt < MAX_DEADLOCK_RETRIES; attempt++) {
      await connection.beginTransaction();
      try {
        const result = await body(attempt);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        const deadlock = isDeadlockError(error);
        if (deadlock && attempt < MAX_DEADLOCK_RETRIES - 1) continue;
        if (deadlock && exhaustedErrorMessage !== undefined) throw new Error(exhaustedErrorMessage, { cause: error });
        throw error;
      }
    }
    throw new Error(`[DB] Deadlock retry limit reached in ${retryLogLabel}.`);
  });
  return {
    acquireNamedLock: vi.fn().mockResolvedValue(undefined),
    releaseNamedLock: vi.fn().mockResolvedValue(undefined),
    getCommandWriteLockName: vi.fn((s: string) => `bcuk_cmd_${s}`),
    isDeadlockError,
    MAX_DEADLOCK_RETRIES,
    runWithDeadlockRetry,
  };
});
vi.mock('./commandStringUtils', () => ({
  CommandConflictError: class CommandConflictError extends Error {
    commands: string[];
    constructor(cmds: string[]) {
      super(String(cmds));
      this.commands = cmds;
    }
  },
  normalizeCommand: vi.fn((command: string) => {
    const normalized = command.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }),
  buildInClausePlaceholders: vi.fn((count: number) => Array(count).fill('?').join(', ')),
}));

import {
  assertDiscordTriggerAvailable,
  assertMultiTwitchTriggerAvailable,
  assertNoSingleTwitchAssignmentOverlap,
  assertNoTwitchChannelTriggerConflict,
  getCommandTriggerStringById,
  getUserTwitchEligibility,
  getUserTwitchEligibilityBatch,
  insertUserCommandAssignment,
  insertUserCommandAssignments,
  assignUserToCommandWithinTransaction,
  assignUsersToCommandWithinTransaction,
} from './commandConflicts';
import { CommandConflictError } from './commandStringUtils';
import { normalizeTwitchChannelName } from '../twitch/twitchChannelName';
import { acquireNamedLock, releaseNamedLock, isDeadlockError } from './commandLocks';
import { makeMockPool } from '../test-utils/mockMysqlPool';

/** Builds a fake mysql pool/executor resolving `execute`/`query` to the given rows. */
// Cast to any to satisfy SqlExecutor (Pool | PoolConnection) without importing full mysql types
function makeExecutor(rows: unknown[] = []): any {
  return makeMockPool({ rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(normalizeTwitchChannelName).mockImplementation((s: string) => s ? s.toLowerCase() : null);
});

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
    const error = await assertDiscordTriggerAvailable('!test', exec).catch((e) => e);
    expect(error.commands).toContain('!test');
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
    await expect(assertNoTwitchChannelTriggerConflict(exec, 1, '!test', 'alice')).resolves.not.toThrow();
  });

  it('throws CommandConflictError when conflict found', async () => {
    const exec = makeExecutor([{ command_id: 3 }]);
    await expect(assertNoTwitchChannelTriggerConflict(exec, 1, '!test', 'alice')).rejects.toBeInstanceOf(CommandConflictError);
  });

  it('passes commandId, triggerString, and normalizedTwitchName to the query', async () => {
    const exec = makeExecutor([]);
    await assertNoTwitchChannelTriggerConflict(exec, 10, '!clap', 'alice');
    const params: unknown[] = exec.execute.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain('!clap');
    expect(params).toContain('alice');
  });
});

// ─── getCommandTriggerStringById ─────────────────────────────────────────────

describe('getCommandTriggerStringById', () => {
  it('throws when no command found', async () => {
    const exec = makeExecutor([]);
    await expect(getCommandTriggerStringById(exec, 99)).rejects.toThrow('Custom command not found: 99');
  });

  it('returns trimmed lowercase trigger string', async () => {
    const exec = makeExecutor([{ trigger_string: '  !CLAP  ' }]);
    const result = await getCommandTriggerStringById(exec, 1);
    expect(result).toBe('!clap');
  });
});

// ─── getUserTwitchEligibility ─────────────────────────────────────────────────

describe('getUserTwitchEligibility', () => {
  it('throws when user not found', async () => {
    const exec = makeExecutor([]);
    await expect(getUserTwitchEligibility(exec, '999')).rejects.toThrow('User not found: 999');
  });

  it('returns null normalizedTwitchName when twitch_name is null', async () => {
    const exec = makeExecutor([{ twitch_name: null, is_twitch_bot_enabled: 0 }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.normalizedTwitchName).toBeNull();
    expect(result.isTwitchBotEnabled).toBe(false);
  });

  it('normalizes twitch_name through normalizeTwitchChannelName', async () => {
    vi.mocked(normalizeTwitchChannelName).mockReturnValue('alice');
    const exec = makeExecutor([{ twitch_name: 'Alice', is_twitch_bot_enabled: 1 }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.normalizedTwitchName).toBe('alice');
    expect(result.isTwitchBotEnabled).toBe(true);
  });

  it('handles is_twitch_bot_enabled as a Buffer with value 0x01 → true', async () => {
    const exec = makeExecutor([{ twitch_name: 'alice', is_twitch_bot_enabled: Buffer.from([1]) }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.isTwitchBotEnabled).toBe(true);
  });

  it('handles is_twitch_bot_enabled as a Buffer with value 0x00 → false', async () => {
    const exec = makeExecutor([{ twitch_name: 'alice', is_twitch_bot_enabled: Buffer.from([0]) }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.isTwitchBotEnabled).toBe(false);
  });

  it('handles is_twitch_bot_enabled as numeric 1 → true', async () => {
    const exec = makeExecutor([{ twitch_name: 'alice', is_twitch_bot_enabled: 1 }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.isTwitchBotEnabled).toBe(true);
  });

  it('handles is_twitch_bot_enabled as numeric 0 → false', async () => {
    const exec = makeExecutor([{ twitch_name: 'alice', is_twitch_bot_enabled: 0 }]);
    const result = await getUserTwitchEligibility(exec, '1');
    expect(result.isTwitchBotEnabled).toBe(false);
  });
});

// ─── insertUserCommandAssignment ──────────────────────────────────────────────

describe('insertUserCommandAssignment', () => {
  it('executes an INSERT with commandId and discordId', async () => {
    const exec = makeExecutor();
    await insertUserCommandAssignment(exec, 5, 'user123');
    expect(exec.execute).toHaveBeenCalledOnce();
    const [sql, params] = exec.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO twitch_user_commands');
    expect(params).toContain(5);
    expect(params).toContain('user123');
  });
});

// ─── assignUserToCommandWithinTransaction ─────────────────────────────────────

describe('assignUserToCommandWithinTransaction', () => {
  function makeConnection(executeResults: unknown[][]): any {
    const execute = vi.fn();
    for (const result of executeResults) {
      execute.mockResolvedValueOnce([result, []]);
    }
    return {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('skips the conflict check and commits for a twitch-ineligible user', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }], // getCommandTriggerStringById
      [{ twitch_name: null, is_twitch_bot_enabled: 0 }], // getUserTwitchEligibility
      [], // insertUserCommandAssignment
    ]);

    await assignUserToCommandWithinTransaction(connection, 1, 'user1');

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(acquireNamedLock).toHaveBeenCalledOnce();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('runs the channel trigger conflict check for an eligible user, then commits', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ twitch_name: 'alice', is_twitch_bot_enabled: 1 }],
      [], // no conflict rows
      [], // insert
    ]);

    await assignUserToCommandWithinTransaction(connection, 1, 'user1');

    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(4);
  });

  it('rolls back and throws CommandConflictError when a channel trigger conflict exists', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ twitch_name: 'alice', is_twitch_bot_enabled: 1 }],
      [{ command_id: 99 }], // conflict row found
    ]);

    await expect(assignUserToCommandWithinTransaction(connection, 1, 'user1')).rejects.toBeInstanceOf(CommandConflictError);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('retries once on a deadlock and succeeds on the second attempt, acquiring the lock only once', async () => {
    const deadlockErr = new Error('deadlock');
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ trigger_string: '!clap' }], []]) // attempt 1: trigger
      .mockResolvedValueOnce([[{ twitch_name: null, is_twitch_bot_enabled: 0 }], []]) // attempt 1: eligibility
      .mockRejectedValueOnce(deadlockErr) // attempt 1: insert fails
      .mockResolvedValueOnce([[{ trigger_string: '!clap' }], []]) // attempt 2: trigger
      .mockResolvedValueOnce([[{ twitch_name: null, is_twitch_bot_enabled: 0 }], []]) // attempt 2: eligibility
      .mockResolvedValueOnce([[], []]); // attempt 2: insert succeeds
    const connection = {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(isDeadlockError).mockReturnValueOnce(true);

    await assignUserToCommandWithinTransaction(connection as any, 1, 'user1');

    expect(connection.beginTransaction).toHaveBeenCalledTimes(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(acquireNamedLock).toHaveBeenCalledOnce();
  });

  it('rethrows the original error after exhausting all retry attempts (no further retry)', async () => {
    const deadlockErr = new Error('deadlock');
    const eligibilityRow = [{ twitch_name: null, is_twitch_bot_enabled: 0 }];
    const triggerRow = [{ trigger_string: '!clap' }];
    const execute = vi.fn()
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr)
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr)
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr);
    const connection = {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    // Called on every failed attempt (including the last, where the attempt-count guard
    // short-circuits the retry regardless of this value).
    vi.mocked(isDeadlockError).mockReturnValueOnce(true).mockReturnValueOnce(true);

    await expect(assignUserToCommandWithinTransaction(connection as any, 1, 'user1')).rejects.toBe(deadlockErr);

    expect(connection.beginTransaction).toHaveBeenCalledTimes(3);
    expect(connection.rollback).toHaveBeenCalledTimes(3);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(acquireNamedLock).toHaveBeenCalledOnce();
  });

  it('throws the stable retry-limit error, not the raw driver error, when a deadlock persists through every attempt', async () => {
    const deadlockErr = new Error('deadlock');
    const eligibilityRow = [{ twitch_name: null, is_twitch_bot_enabled: 0 }];
    const triggerRow = [{ trigger_string: '!clap' }];
    const execute = vi.fn()
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr)
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr)
      .mockResolvedValueOnce([triggerRow, []]).mockResolvedValueOnce([eligibilityRow, []]).mockRejectedValueOnce(deadlockErr);
    const connection = {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    // isDeadlockError reports true on every attempt, including the last — unlike the
    // "no further retry" case above, where it reports false on the last attempt. Queued as
    // one-time values (not a persistent mockReturnValue) so this doesn't leak into later tests.
    vi.mocked(isDeadlockError).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true);

    await expect(assignUserToCommandWithinTransaction(connection as any, 1, 'user1'))
      .rejects.toThrow('[DB] Deadlock retry limit reached in assignUserToCommandWithinTransaction.');

    expect(connection.beginTransaction).toHaveBeenCalledTimes(3);
    expect(connection.rollback).toHaveBeenCalledTimes(3);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(acquireNamedLock).toHaveBeenCalledOnce();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('rethrows a non-deadlock error immediately without retrying', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ twitch_name: null, is_twitch_bot_enabled: 0 }],
    ]);
    connection.execute.mockRejectedValueOnce(new Error('unexpected failure'));

    await expect(assignUserToCommandWithinTransaction(connection, 1, 'user1')).rejects.toThrow('unexpected failure');
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it('still releases the lock in the finally block when acquiring it failed', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ twitch_name: null, is_twitch_bot_enabled: 0 }],
    ]);
    vi.mocked(acquireNamedLock).mockRejectedValueOnce(new Error('lock timeout'));

    await expect(assignUserToCommandWithinTransaction(connection, 1, 'user1')).rejects.toThrow('lock timeout');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('swallows a releaseNamedLock failure in the finally block without masking the result', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ twitch_name: null, is_twitch_bot_enabled: 0 }],
      [],
    ]);
    vi.mocked(releaseNamedLock).mockRejectedValueOnce(new Error('release failed'));

    await expect(assignUserToCommandWithinTransaction(connection, 1, 'user1')).resolves.toBeUndefined();
  });

});

// ─── getUserTwitchEligibilityBatch ─────────────────────────────────────────────

describe('getUserTwitchEligibilityBatch', () => {
  it('returns an empty map without querying when discordIds is empty', async () => {
    const exec = makeExecutor();
    const result = await getUserTwitchEligibilityBatch(exec, []);
    expect(result.size).toBe(0);
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it('maps each returned row by discord_id, normalizing twitch_name', async () => {
    vi.mocked(normalizeTwitchChannelName).mockImplementation((s: string) => s.toLowerCase());
    const exec = makeExecutor([
      { discord_id: 'user1', twitch_name: 'Alice', is_twitch_bot_enabled: 1 },
      { discord_id: 'user2', twitch_name: null, is_twitch_bot_enabled: 0 },
    ]);
    const result = await getUserTwitchEligibilityBatch(exec, ['user1', 'user2']);
    expect(result.get('user1')).toEqual({ normalizedTwitchName: 'alice', isTwitchBotEnabled: true });
    expect(result.get('user2')).toEqual({ normalizedTwitchName: null, isTwitchBotEnabled: false });
  });

  it('omits discordIds with no matching row', async () => {
    const exec = makeExecutor([{ discord_id: 'user1', twitch_name: null, is_twitch_bot_enabled: 0 }]);
    const result = await getUserTwitchEligibilityBatch(exec, ['user1', 'missing']);
    expect(result.has('missing')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('queries with a single IN clause covering all discordIds', async () => {
    const exec = makeExecutor([]);
    await getUserTwitchEligibilityBatch(exec, ['a', 'b', 'c']);
    expect(exec.execute).toHaveBeenCalledOnce();
    const [sql, params] = exec.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('IN (?, ?, ?)');
    expect(params).toEqual(['a', 'b', 'c']);
  });
});

// ─── insertUserCommandAssignments ──────────────────────────────────────────────

describe('insertUserCommandAssignments', () => {
  it('does not query when discordIds is empty', async () => {
    const exec = makeExecutor();
    await insertUserCommandAssignments(exec, 5, []);
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it('issues a single multi-row INSERT covering all discordIds', async () => {
    const exec = makeExecutor();
    await insertUserCommandAssignments(exec, 5, ['user1', 'user2', 'user3']);
    expect(exec.execute).toHaveBeenCalledOnce();
    const [sql, params] = exec.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO twitch_user_commands');
    expect(sql).toContain('AS new_row');
    expect(params).toEqual([5, 'user1', 5, 'user2', 5, 'user3']);
  });
});

// ─── assignUsersToCommandWithinTransaction ─────────────────────────────────────

describe('assignUsersToCommandWithinTransaction', () => {
  function makeConnection(executeResults: unknown[][]): any {
    const execute = vi.fn();
    for (const result of executeResults) {
      execute.mockResolvedValueOnce([result, []]);
    }
    return {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('no-ops without opening a transaction when discordIds is empty', async () => {
    const connection = makeConnection([]);
    await assignUsersToCommandWithinTransaction(connection, 1, []);
    expect(connection.beginTransaction).not.toHaveBeenCalled();
    expect(acquireNamedLock).not.toHaveBeenCalled();
  });

  it('acquires the lock once, inserts all users in one batch, and commits', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }], // getCommandTriggerStringById
      [
        { discord_id: 'user1', twitch_name: null, is_twitch_bot_enabled: 0 },
        { discord_id: 'user2', twitch_name: null, is_twitch_bot_enabled: 0 },
      ], // getUserTwitchEligibilityBatch
      [], // insertUserCommandAssignments
    ]);

    await assignUsersToCommandWithinTransaction(connection, 1, ['user1', 'user2']);

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(3);
    expect(acquireNamedLock).toHaveBeenCalledOnce();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('runs a single batched channel trigger conflict check covering every eligible user', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [
        { discord_id: 'user1', twitch_name: 'alice', is_twitch_bot_enabled: 1 },
        { discord_id: 'user2', twitch_name: 'bob', is_twitch_bot_enabled: 1 },
      ],
      [], // one batched conflict check covering both eligible users
      [], // insert
    ]);

    await assignUsersToCommandWithinTransaction(connection, 1, ['user1', 'user2']);

    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(4);
    const [conflictSql, conflictParams] = connection.execute.mock.calls[2] as [string, unknown[]];
    expect(conflictSql).toContain('IN (?, ?)');
    expect(conflictParams).toEqual([1, '!clap', 'alice', 'bob']);
  });

  it('skips the conflict check entirely when no assigned user is Twitch-eligible', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [
        { discord_id: 'user1', twitch_name: null, is_twitch_bot_enabled: 0 },
        { discord_id: 'user2', twitch_name: 'bob', is_twitch_bot_enabled: 0 },
      ],
      [], // insert
    ]);

    await assignUsersToCommandWithinTransaction(connection, 1, ['user1', 'user2']);

    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.execute).toHaveBeenCalledTimes(3);
  });

  it('rolls back and throws CommandConflictError when any eligible user has a channel conflict', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [{ discord_id: 'user1', twitch_name: 'alice', is_twitch_bot_enabled: 1 }],
      [{ command_id: 99 }], // conflict row found
    ]);

    await expect(assignUsersToCommandWithinTransaction(connection, 1, ['user1'])).rejects.toBeInstanceOf(CommandConflictError);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });

  it('rolls back and throws when a discordId has no matching user', async () => {
    const connection = makeConnection([
      [{ trigger_string: '!clap' }],
      [], // no rows for either user — nobody found
    ]);

    await expect(assignUsersToCommandWithinTransaction(connection, 1, ['ghost'])).rejects.toThrow('User not found: ghost');
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(releaseNamedLock).toHaveBeenCalledOnce();
  });

  it('retries once on a deadlock and succeeds on the second attempt, acquiring the lock only once', async () => {
    const deadlockErr = new Error('deadlock');
    const triggerRow = [{ trigger_string: '!clap' }];
    const eligibilityRows = [{ discord_id: 'user1', twitch_name: null, is_twitch_bot_enabled: 0 }];
    const execute = vi.fn()
      .mockResolvedValueOnce([triggerRow, []])
      .mockResolvedValueOnce([eligibilityRows, []])
      .mockRejectedValueOnce(deadlockErr) // attempt 1: insert fails
      .mockResolvedValueOnce([triggerRow, []])
      .mockResolvedValueOnce([eligibilityRows, []])
      .mockResolvedValueOnce([[], []]); // attempt 2: insert succeeds
    const connection = {
      execute,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(isDeadlockError).mockReturnValueOnce(true);

    await assignUsersToCommandWithinTransaction(connection as any, 1, ['user1']);

    expect(connection.beginTransaction).toHaveBeenCalledTimes(2);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(acquireNamedLock).toHaveBeenCalledOnce();
  });
});
