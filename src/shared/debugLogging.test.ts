import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const setDebugLogFile = vi.hoisted(() => vi.fn(() => true));
vi.mock('./logger', () => ({ createLogger: () => log, setDebugLogFile }));

// An in-memory stand-in for the few fs.promises calls the module makes.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (file: string, data: string) => { files.set(file, data); }),
    readFile: vi.fn(async (file: string) => {
      const data = files.get(file);
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return data;
    }),
    rm: vi.fn(async (file: string) => { files.delete(file); }),
  },
}));

import {
  enableDebugLogging, disableDebugLogging, restoreDebugLogging, getDebugLoggingUntil,
  DEBUG_LOGGING_STATE_FILE, MAX_DEBUG_LOGGING_HOURS,
} from './debugLogging';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function readState(): unknown {
  return JSON.parse(files.get(DEBUG_LOGGING_STATE_FILE)!);
}

function stateSaved(): boolean {
  return files.has(DEBUG_LOGGING_STATE_FILE);
}

function writeState(contents: string) {
  files.set(DEBUG_LOGGING_STATE_FILE, contents);
}

beforeEach(async () => {
  files.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await disableDebugLogging();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enableDebugLogging', () => {
  it('turns the debug file on, saves the switch-off time and reports it', async () => {
    const until = await enableDebugLogging(24, NOW);

    expect(until.toISOString()).toBe(new Date(NOW + 24 * HOUR).toISOString());
    expect(setDebugLogFile).toHaveBeenCalledWith(true);
    expect(readState()).toEqual({ until: until.toISOString() });
    expect(getDebugLoggingUntil()).toEqual(until);
  });

  it('switches itself off when the time runs out', async () => {
    await enableDebugLogging(6, NOW);

    await vi.advanceTimersByTimeAsync(6 * HOUR);

    expect(setDebugLogFile).toHaveBeenLastCalledWith(false);
    expect(getDebugLoggingUntil()).toBeNull();
    expect(stateSaved()).toBe(false);
  });

  it('restarts the timer when turned on again', async () => {
    await enableDebugLogging(1, NOW);
    await enableDebugLogging(6, NOW + HOUR / 2);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(getDebugLoggingUntil()).not.toBeNull();
    expect(setDebugLogFile).not.toHaveBeenCalledWith(false);
  });

  it.each([0, -1, 1.5, MAX_DEBUG_LOGGING_HOURS + 1, Number.NaN])('rejects %s hours', async (hours) => {
    await expect(enableDebugLogging(hours, NOW)).rejects.toThrow(RangeError);
    expect(setDebugLogFile).not.toHaveBeenCalled();
  });
});

describe('disableDebugLogging', () => {
  it('turns the debug file off and removes the saved state', async () => {
    await enableDebugLogging(24, NOW);

    await disableDebugLogging();

    expect(setDebugLogFile).toHaveBeenLastCalledWith(false);
    expect(getDebugLoggingUntil()).toBeNull();
    expect(stateSaved()).toBe(false);
  });
});

describe('restoreDebugLogging', () => {
  it('stays off when nothing was saved', async () => {
    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(setDebugLogFile).not.toHaveBeenCalledWith(true);
  });

  it('turns debug logging back on for the time left, then off on time', async () => {
    const until = new Date(NOW + 3 * HOUR);
    writeState(JSON.stringify({ until: until.toISOString() }));

    expect(await restoreDebugLogging(NOW)).toEqual(until);
    expect(setDebugLogFile).toHaveBeenCalledWith(true);

    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(getDebugLoggingUntil()).toBeNull();
  });

  it('switches off and removes a saved time that has already passed', async () => {
    writeState(JSON.stringify({ until: new Date(NOW - HOUR).toISOString() }));

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(stateSaved()).toBe(false);
  });

  it('refuses a saved time further out than the maximum', async () => {
    writeState(JSON.stringify({ until: new Date(NOW + (MAX_DEBUG_LOGGING_HOURS + 1) * HOUR).toISOString() }));

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(setDebugLogFile).not.toHaveBeenCalledWith(true);
  });

  it('logs and stays off when the saved file is unreadable, without throwing', async () => {
    writeState('not json');

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('debug logging state'), expect.anything());
  });

  it('treats a missing or invalid until as nothing to restore', async () => {
    writeState(JSON.stringify({ until: 'soon' }));

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(stateSaved()).toBe(false);
  });
});
