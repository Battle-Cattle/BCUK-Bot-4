import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./timerCommands', () => ({
  addTimerCommand: vi.fn(),
  updateTimerCommand: vi.fn(),
  removeTimerCommand: vi.fn(),
  setTimerCommandEnabled: vi.fn(),
  assignUserToTimer: vi.fn(),
  assignUsersToTimer: vi.fn(),
  unassignUserFromTimer: vi.fn(),
  updateOwnTimerCommand: vi.fn(),
  setOwnTimerCommandEnabled: vi.fn(),
  removeOwnTimerCommand: vi.fn(),
  discardOwnNewTimerCommand: vi.fn(),
}));
vi.mock('./timerCommandCache', () => ({ invalidateTimerCommandCache: vi.fn() }));

import * as records from './timerCommands';
import { invalidateTimerCommandCache } from './timerCommandCache';
import * as writes from './timerCommandWrites';

const INPUT = { name: 'Socials', message: 'Follow me', intervalSeconds: 600, minMessages: 0, requireLive: true, enabled: true };

// Each wrapper: [export name, args]. The record function shares the wrapper's name.
const CASES: Array<[keyof typeof writes, unknown[]]> = [
  ['addTimerCommand', [INPUT]],
  ['updateTimerCommand', [1, INPUT]],
  ['removeTimerCommand', [1]],
  ['setTimerCommandEnabled', [1, false]],
  ['assignUserToTimer', [1, '111']],
  ['assignUsersToTimer', [1, ['111', '222']]],
  ['unassignUserFromTimer', [1, '111']],
  ['updateOwnTimerCommand', [1, INPUT, '111']],
  ['setOwnTimerCommandEnabled', [1, false, '111']],
  ['removeOwnTimerCommand', [1, '111']],
  ['discardOwnNewTimerCommand', [1, '111']],
];

/** Calls a wrapper or record function by name with loosely typed args. */
function call(module: Record<string, unknown>, name: string, args: unknown[]): Promise<unknown> {
  return (module[name] as (...a: unknown[]) => Promise<unknown>)(...args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('timer command write wrappers', () => {
  it('wraps every timerCommands.ts write that the facade exports', () => {
    expect(Object.keys(writes).sort()).toEqual(CASES.map(([name]) => name).sort());
  });

  it.each(CASES)('%s calls the record function and invalidates the cache', async (name, args) => {
    vi.mocked(records[name]).mockResolvedValue(undefined as never);
    await call(writes, name, args);
    expect(records[name]).toHaveBeenCalledWith(...args);
    expect(invalidateTimerCommandCache).toHaveBeenCalledOnce();
  });

  it.each(CASES)('%s propagates errors without invalidating', async (name, args) => {
    vi.mocked(records[name]).mockRejectedValue(new Error('DB error'));
    await expect(call(writes, name, args)).rejects.toThrow('DB error');
    expect(invalidateTimerCommandCache).not.toHaveBeenCalled();
  });

  it('addTimerCommand returns the new id', async () => {
    vi.mocked(records.addTimerCommand).mockResolvedValue(42);
    await expect(writes.addTimerCommand(INPUT)).resolves.toBe(42);
  });
});
