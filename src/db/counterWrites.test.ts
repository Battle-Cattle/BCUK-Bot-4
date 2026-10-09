import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./counters', () => ({
  addCounter: vi.fn(),
  updateCounter: vi.fn(),
  removeCounter: vi.fn(),
  resetCounterCurrentValue: vi.fn(),
  incrementCounter: vi.fn(),
}));
vi.mock('./counterArchive', () => ({ archiveAndResetYearlyCounters: vi.fn() }));
vi.mock('./counterCache', () => ({ invalidateCounterLookupCache: vi.fn() }));

import {
  addCounter as addCounterRecord,
  updateCounter as updateCounterRecord,
  removeCounter as removeCounterRecord,
  resetCounterCurrentValue as resetCounterCurrentValueRecord,
  incrementCounter as incrementCounterRecord,
} from './counters';
import { archiveAndResetYearlyCounters as archiveAndResetYearlyCountersRecord } from './counterArchive';
import { invalidateCounterLookupCache } from './counterCache';
import {
  addCounter, updateCounter, removeCounter, resetCounterCurrentValue, incrementCounter, archiveAndResetYearlyCounters,
} from './counterWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addCounterRecord).mockResolvedValue(undefined);
  vi.mocked(updateCounterRecord).mockResolvedValue(undefined);
  vi.mocked(removeCounterRecord).mockResolvedValue(undefined);
  vi.mocked(resetCounterCurrentValueRecord).mockResolvedValue(undefined);
  vi.mocked(incrementCounterRecord).mockResolvedValue(1);
  vi.mocked(archiveAndResetYearlyCountersRecord).mockResolvedValue(0);
});

// ─── Counter write wrappers ────────────────────────────────────────────────────
//
// counters.ts is a pure DB layer with no cache knowledge; these tests verify
// these wrappers invalidate the counter lookup cache after each write.

describe('addCounter', () => {
  const NEW_COUNTER = { triggerCommand: '!hits', checkCommand: '!checkhits', message: 'msg', incrementMessage: 'inc', resetYearly: false };

  it('calls the record function and invalidates the cache on success', async () => {
    await addCounter('guild-1', NEW_COUNTER);
    expect(addCounterRecord).toHaveBeenCalledWith('guild-1', NEW_COUNTER);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(addCounterRecord).mockRejectedValue(new Error('DB error'));
    await expect(addCounter('guild-1', NEW_COUNTER)).rejects.toThrow('DB error');
    expect(invalidateCounterLookupCache).not.toHaveBeenCalled();
  });
});

describe('updateCounter', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    const input = { id: 1, triggerCommand: '!hits', checkCommand: '!checkhits', message: 'm', incrementMessage: 'i', resetYearly: false };
    await updateCounter('guild-1', input);
    expect(updateCounterRecord).toHaveBeenCalledWith('guild-1', input);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('removeCounter', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await removeCounter('guild-1', 1);
    expect(removeCounterRecord).toHaveBeenCalledWith('guild-1', 1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('resetCounterCurrentValue', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await resetCounterCurrentValue('guild-1', 1);
    expect(resetCounterCurrentValueRecord).toHaveBeenCalledWith('guild-1', 1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('incrementCounter', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(incrementCounterRecord).mockResolvedValue(7);
    const result = await incrementCounter(1);
    expect(result).toBe(7);
    expect(incrementCounterRecord).toHaveBeenCalledWith(1);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});

describe('archiveAndResetYearlyCounters', () => {
  it('calls the record function, returns its value, and invalidates the cache on success', async () => {
    vi.mocked(archiveAndResetYearlyCountersRecord).mockResolvedValue(3);
    const result = await archiveAndResetYearlyCounters(2024);
    expect(result).toBe(3);
    expect(archiveAndResetYearlyCountersRecord).toHaveBeenCalledWith(2024);
    expect(invalidateCounterLookupCache).toHaveBeenCalledOnce();
  });
});
