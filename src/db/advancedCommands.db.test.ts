import { describe, it, expect } from 'vitest';
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
