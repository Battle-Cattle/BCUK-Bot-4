import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./lookupCache', () => ({
  createManagedLookupCache: vi.fn(({ loadCache }: { loadCache: () => Promise<unknown> }) => ({
    getCache: () => loadCache(),
    invalidate: vi.fn(),
  })),
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

function makeCounter(id: number, trigger: string, check: string): DbCounter {
  return {
    id,
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
    const result = await findCounterByCommand('');
    expect(result).toBeNull();
    expect(getAllCounters).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only string without making a DB call', async () => {
    const result = await findCounterByCommand('   ');
    expect(result).toBeNull();
    expect(getAllCounters).not.toHaveBeenCalled();
  });

  it('finds a counter by its trigger_command and returns matchType trigger', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('trigger');
  });

  it('finds a counter by its check_command and returns matchType check', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('!checkhits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('check');
  });

  it('performs a case-insensitive lookup', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('!HITS');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.matchType).toBe('trigger');
  });

  it('trims whitespace from the lookup string', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const result = await findCounterByCommand('  !hits  ');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('returns null when no counter matches the command', async () => {
    vi.mocked(getAllCounters).mockResolvedValue([makeCounter(1, '!hits', '!checkhits')]);

    const result = await findCounterByCommand('!unknown');

    expect(result).toBeNull();
  });

  it('returns a copy — mutating the result does not affect subsequent lookups', async () => {
    const counter = makeCounter(1, '!hits', '!checkhits');
    vi.mocked(getAllCounters).mockResolvedValue([counter]);

    const first = await findCounterByCommand('!hits');
    expect(first).not.toBeNull();
    first!.current_value = 9999;

    const second = await findCounterByCommand('!hits');
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

    const result = await findCounterByCommand('!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('sorts by id before processing so lower id still wins even when given in reverse order', async () => {
    const loser = makeCounter(2, '!hits', '!checkhits2');
    const winner = makeCounter(1, '!hits', '!checkhits1');
    vi.mocked(getAllCounters).mockResolvedValue([loser, winner]);

    const result = await findCounterByCommand('!hits');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
  });

  it('returns null for any command when the counter list is empty', async () => {
    vi.mocked(getAllCounters).mockResolvedValue([]);

    const result = await findCounterByCommand('!anything');

    expect(result).toBeNull();
  });
});

// ─── isCounterCommandTaken ───────────────────────────────────────────────────

describe('isCounterCommandTaken', () => {
  it('returns true immediately for an array containing duplicates without delegating to isAnyCommandTakenAcrossTables', async () => {
    const result = await isCounterCommandTaken(['!hits', '!hits']);

    expect(result).toBe(true);
    expect(isAnyCommandTakenAcrossTables).not.toHaveBeenCalled();
  });

  it('delegates to isAnyCommandTakenAcrossTables for a single string input', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken('!hits', 42);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith('!hits', { excludeCounterId: 42 });
  });

  it('delegates to isAnyCommandTakenAcrossTables for an array with no duplicates', async () => {
    vi.mocked(isAnyCommandTakenAcrossTables).mockResolvedValue(false);

    await isCounterCommandTaken(['!hits', '!checkhits']);

    expect(isAnyCommandTakenAcrossTables).toHaveBeenCalledWith(['!hits', '!checkhits'], { excludeCounterId: undefined });
  });
});
