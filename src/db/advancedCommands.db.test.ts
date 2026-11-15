import { describe, it, expect } from 'vitest';
import type mysql from 'mysql2/promise';
import { getPool } from './pool';
import { addAdvancedCommand, AdvancedCommandConflictError, updateAdvancedCommand } from './advancedCommands';
import type { AdvancedCommandSettings } from './advancedCommandValidation';
import { insertRow } from '../test-utils/realDbRows';

// Advanced commands' unique indexes against a real MySQL (npm run test:db): a clash on
// uq_advanced_command_name or uq_advanced_command_trigger becomes an AdvancedCommandConflictError
// naming the field. runGuardedWrite tells them apart by MySQL's error message, which only a real
// server produces.

function settings(overrides: Partial<AdvancedCommandSettings> = {}): AdvancedCommandSettings {
  return {
    name: 'Hydrate', triggerString: '!hydrate', isEnabled: true, response: null, pointCost: 100, priceStep: 0,
    maxCost: null, globalCooldownSeconds: 0, userCooldownSeconds: 0, minRole: 'everyone', liveOnly: false,
    maxUsesPerStream: null, maxUsesPerUserPerStream: null, companionEnabled: true, ...overrides,
  };
}

async function newStreamerId(): Promise<number> {
  return Number((await insertRow('streamer')).id);
}

async function conflictField(write: Promise<unknown>): Promise<string> {
  const err = await write.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AdvancedCommandConflictError);
  return (err as AdvancedCommandConflictError).field;
}

describe('advanced command unique names and triggers (real MySQL)', () => {
  it("rejects a second command with the same name for the same streamer, as a name conflict", async () => {
    const streamerId = await newStreamerId();
    await addAdvancedCommand(streamerId, settings());

    expect(await conflictField(addAdvancedCommand(streamerId, settings({ triggerString: '!water' })))).toBe('name');
  });

  it('rejects a second command with the same trigger for the same streamer, as a trigger conflict', async () => {
    const streamerId = await newStreamerId();
    await addAdvancedCommand(streamerId, settings());

    expect(await conflictField(addAdvancedCommand(streamerId, settings({ name: 'Water' })))).toBe('trigger');
  });

  it('rejects renaming a command onto another one of the same streamer', async () => {
    const streamerId = await newStreamerId();
    await addAdvancedCommand(streamerId, settings());
    const otherId = await addAdvancedCommand(streamerId, settings({ name: 'Water', triggerString: null }));

    expect(await conflictField(updateAdvancedCommand(streamerId, otherId, settings({ triggerString: null })))).toBe('name');
  });

  it('allows the same name and trigger for different streamers', async () => {
    await addAdvancedCommand(await newStreamerId(), settings());

    await expect(addAdvancedCommand(await newStreamerId(), settings())).resolves.toEqual(expect.any(Number));
  });
});

// ─── CHECK constraints (0002_advanced_commands.sql) ───────────────────────────

interface CheckCase {
  constraint: string;
  table: string;
  /** Column values that break the constraint. */
  violating: Record<string, unknown>;
  /** The closest values that satisfy it. */
  boundary: Record<string, unknown>;
}

const CHECK_CASES: CheckCase[] = [
  { constraint: 'chk_advanced_command_point_cost', table: 'advanced_command', violating: { point_cost: -1 }, boundary: { point_cost: 0 } },
  { constraint: 'chk_advanced_command_price_step', table: 'advanced_command', violating: { price_step: -1 }, boundary: { price_step: 0 } },
  { constraint: 'chk_advanced_command_max_cost', table: 'advanced_command', violating: { point_cost: 10, max_cost: 9 }, boundary: { point_cost: 10, max_cost: 10 } },
  { constraint: 'chk_advanced_command_global_cooldown', table: 'advanced_command', violating: { global_cooldown_seconds: -1 }, boundary: { global_cooldown_seconds: 0 } },
  { constraint: 'chk_advanced_command_user_cooldown', table: 'advanced_command', violating: { user_cooldown_seconds: -1 }, boundary: { user_cooldown_seconds: 0 } },
  { constraint: 'chk_advanced_command_max_uses', table: 'advanced_command', violating: { max_uses_per_stream: 0 }, boundary: { max_uses_per_stream: 1 } },
  { constraint: 'chk_advanced_command_max_user_uses', table: 'advanced_command', violating: { max_uses_per_user_per_stream: 0 }, boundary: { max_uses_per_user_per_stream: 1 } },
  { constraint: 'chk_advanced_command_alert_duration', table: 'advanced_command_alert', violating: { duration_ms: 0 }, boundary: { duration_ms: 1 } },
  { constraint: 'chk_advanced_command_usage_points', table: 'advanced_command_usage', violating: { points_spent: -1 }, boundary: { points_spent: 0 } },
];

describe('advanced command CHECK constraints (real MySQL)', () => {
  it('has a case here for every CHECK constraint on the advanced command tables', async () => {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' AND TABLE_NAME LIKE 'advanced\\_command%'
       ORDER BY CONSTRAINT_NAME`,
    );
    expect(rows.map((r) => r.name)).toEqual(CHECK_CASES.map((c) => c.constraint).sort());
  });

  it.each(CHECK_CASES)('$constraint rejects a row that breaks it and accepts the boundary', async ({ constraint, table, violating, boundary }) => {
    await expect(insertRow(table, violating)).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED',
      message: expect.stringContaining(constraint),
    });

    await expect(insertRow(table, boundary)).resolves.toMatchObject(boundary);
  });
});
