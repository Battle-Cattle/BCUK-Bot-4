import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lookupCache', () => ({
  createManagedLookupCache: vi.fn(({ loadCache }: { loadCache: () => Promise<unknown> }) => ({
    getCache: () => loadCache(),
    invalidate: vi.fn(),
  })),
  registerFirstWinsWithWarning: vi.fn(<K, V>(map: Map<K, V>, key: K, value: V, describeCollision: (existing: V) => string) => {
    const existing = map.get(key);
    if (existing !== undefined) {
      describeCollision(existing);
      return;
    }
    map.set(key, value);
  }),
  DEFAULT_CACHE_TTL_MS: 300_000,
  DEFAULT_REFRESH_FAILURE_BACKOFF_MS: 5_000,
  DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS: 60_000,
}));
vi.mock('./counters', () => ({
  getAllCounters: vi.fn(),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('./commandLocks', () => ({
  isAnyCommandTakenAcrossTables: vi.fn(),
}));
vi.mock('./commandStringUtils', () => ({
  normalizeCommandList: vi.fn((arr: string[]) => arr.map((s: string) => s.trim().toLowerCase())),
  normalizeCommand: vi.fn((command: string) => {
    const normalized = command.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }),
}));

import { findCounterByCommand, isCounterCommandTaken } from './counterCache';
import { getAllCounters } from './counters';
import { isAnyCommandTakenAcrossTables } from './commandLocks';
import type { DbCounter } from './counters';

function makeCounter(id: number, trigger: string, check: string, guildId = 'guild-1'): DbCounter {
  return {
    id,
    guild_id: guildId,
    trigger_command: trigger,
    check_command: check,
    message: '',
    increment_message: '',
    reset_yearly: false,
    current_value: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllCounters).mockResolvedValue([]);
});

// ─── findCounterByCommand ────────────────────────────────────────────────────

describe('findCounterByCommand', () => {
  it('returns null for an empty string without making a DB call', async () => {
    const result = await findCounterByCommand('guild-1', '');
    expect(result).toBeNull();
    expect(getAllCounters).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only string without making a DB call', async () => {
    const result = await findCounterByCommand('guild-1', '   ');
    expect(result).toBeNull();
    expect(getAllCounters).not.toHaveBeenCalled();
  });

  it('finds a counter by its trigger_command and returns matchType trigger', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('guild-1', '!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('trigger');
  });

  it('finds a counter by its check_command and returns matchType check', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('guild-1', '!checkhits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('check');
  });

  it('performs a case-insensitive lookup', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('guild-1', '!HITS');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('trigger');
  });

  it('trims whitespace from the lookup string', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('guild-1', '  !hits  ');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('returns null when no counter matches the command', async () => {
    vi.mocked(getAllCounters).mockResolvedValue([makeCounter(1, '!hits', '!checkhits')]);

    const result = await findCounterByCommand('guild-1', '!unknown');

    expect(result).toBeNull();
  });

  it('returns a copy — mutating the result does not affect subsequent lookups', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const first = await findCounterByCommand('guild-1', '!hits');
    expect(first).not.toBeNull();
    first!.current_value = 9999;

    const second = await findCounterByCommand('guild-1', '!hits');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.current_value).toBe(0);
  });
});

// ─── buildCounterLookupCache behaviour (via findCounterByCommand) ────────────

describe('buildCounterLookupCache (via findCounterByCommand)', () => {
  it('collision — lower id wins when two counters share the same trigger_command', async () => {
    const winner = makeCounter(1, '!hits', '!checkhits1');
    const loser = makeCounter(2, '!hits', '!checkhits2');
    vi.mocked(getAllCounters).mockResolvedValue([winner, loser]);

    const result = await findCounterByCommand('guild-1', '!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('builds a descriptive collision message naming both counter ids', async () => {
    const { registerFirstWinsWithWarning } = await import('./lookupCache.js');
    const winner = makeCounter(1, '!hits', '!checkhits1');
    const loser = makeCounter(2, '!hits', '!checkhits2');
    vi.mocked(getAllCounters).mockResolvedValue([winner, loser]);

    await findCounterByCommand('guild-1', '!hits');

    const hitsCalls = vi.mocked(registerFirstWinsWithWarning).mock.calls.filter((call) => call[1] === 'guild-1:!hits');
    expect(hitsCalls).toHaveLength(2);
    const describeCollision = hitsCalls[1][3] as (existing: unknown) => string;
    expect(describeCollision({ ...winner, matchType: 'trigger' })).toBe(
      "Counter trigger_command collision: '!hits' in guild guild-1 is already registered (counter id=1); ignoring duplicate from counter id=2.",
    );
  });

  it('sorts by id before processing so lower id still wins even when given in reverse order', async () => {
    const loser = makeCounter(2, '!hits', '!checkhits2');
    const winner = makeCounter(1, '!hits', '!checkhits1');
    vi.mocked(getAllCounters).mockResolvedValue([loser, winner]);

    const result = await findCounterByCommand('guild-1', '!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('returns null for any command when the counter list is empty', async () => {
    vi.mocked(getAllCounters).mockResolvedValue([]);

    const result = await findCounterByCommand('guild-1', '!anything');

    expect(result).toBeNull();
  });
});

// ─── isCounterCommandTaken ───────────────────────────────────────────────────

describe('isCounterCommandTaken', () => {
  it('returns true immediately for an array containing duplicates without delegating to isAnyCommandTakenAcrossTables', async () => {
    const result = await isCounterCommandTaken('guild-1', ['!hits', '!hits']);

    expect(result).toBe(true);
    expect(isAnyCommandTakenAcrossTables).not.toHaveBeenCalled();
  });

  it('delegates to isAnyCommandTakenAcrossTables for a single string input, scoped to the given guild', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken('guild-1', '!hits', 42);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith('!hits', { excludeCounterId: 42, guildId: 'guild-1' });
  });

  it('delegates to isAnyCommandTakenAcrossTables for an array with no duplicates, scoped to the given guild', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken('guild-1', ['!hits', '!checkhits']);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith(['!hits', '!checkhits'], { excludeCounterId: undefined, guildId: 'guild-1' });
  });
});

// ─── guild scoping ────────────────────────────────────────────────────────────

describe('guild scoping', () => {
  it('does not find a counter registered in a different guild', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits', 'guild-a');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('guild-b', '!hits');

    expect(result).toBeNull();
  });

  it('finds the correct guild\'s counter when two guilds share the same trigger_command', async () => {
    const counterA = makeCounter(1, '!hits', '!checkhitsA', 'guild-a');
    const counterB = makeCounter(2, '!hits', '!checkhitsB', 'guild-b');
    vi.mocked(getAllCounters).mockResolvedValue([counterA, counterB]);

    const resultA = await findCounterByCommand('guild-a', '!hits');
    const resultB = await findCounterByCommand('guild-b', '!hits');

    expect(resultA!.id).toBe(1);
    expect(resultB!.id).toBe(2);
  });

  it('does not log a collision warning for the same trigger_command used by two different guilds', async () => {
    const { registerFirstWinsWithWarning } = await import('./lookupCache.js');
    const counterA = makeCounter(1, '!hits', '!checkhitsA', 'guild-a');
    const counterB = makeCounter(2, '!hits', '!checkhitsB', 'guild-b');
    vi.mocked(getAllCounters).mockResolvedValue([counterA, counterB]);

    await findCounterByCommand('guild-a', '!hits');

    const triggerCalls = vi.mocked(registerFirstWinsWithWarning).mock.calls.filter((call) => call[1] === 'guild-a:!hits' || call[1] === 'guild-b:!hits');
    expect(triggerCalls).toHaveLength(2);
  });
});
