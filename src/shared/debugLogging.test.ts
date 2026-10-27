import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const setDebugLogFile = vi.hoisted(() => vi.fn(() => true));
vi.mock('./logger', () => ({ createLogger: () => log, setDebugLogFile, LOG_DIR: 'logs', DEBUG_LOG_RETENTION_DAYS: 3 }));

// An in-memory stand-in for the few fs.promises calls the module makes. Keys are paths; the log
// folder's listing is every key under `logs/`, and mtimes default to 0 unless set.
const files = vi.hoisted(() => new Map<string, string>());
const mtimes = vi.hoisted(() => new Map<string, number>());
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (file: string, data: string) => { files.set(file, data); }),
    readFile: vi.fn(async (file: string) => {
      const data = files.get(file);
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return data;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const data = files.get(from);
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.set(to, data);
      files.delete(from);
    }),
    rm: vi.fn(async (file: string) => { files.delete(file); }),
    readdir: vi.fn(async (dir: string) => [...files.keys()]
      .filter((f) => f.startsWith(`${dir}/`))
      .map((f) => f.slice(dir.length + 1))),
    stat: vi.fn(async (file: string) => ({ mtimeMs: mtimes.get(file) ?? 0 })),
  },
}));

import {
  enableDebugLogging, disableDebugLogging, restoreDebugLogging, getDebugLoggingUntil,
  pruneOldDebugLogs, startDebugLogPruning, stopDebugLogPruning,
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
  mtimes.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await disableDebugLogging();
  vi.clearAllMocks();
});

afterEach(() => {
  stopDebugLogPruning();
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

  it('writes the state to a temporary file and renames it into place', async () => {
    const { promises } = await import('fs');

    await enableDebugLogging(24, NOW);

    expect(promises.writeFile).toHaveBeenCalledWith(`${DEBUG_LOGGING_STATE_FILE}.tmp`, expect.any(String));
    expect(promises.rename).toHaveBeenCalledWith(`${DEBUG_LOGGING_STATE_FILE}.tmp`, DEBUG_LOGGING_STATE_FILE);
    expect([...files.keys()]).toEqual([DEBUG_LOGGING_STATE_FILE]);
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

  it('saves the switch-off time but reports debug logging off when there is no debug file to switch', async () => {
    setDebugLogFile.mockReturnValueOnce(false);

    await enableDebugLogging(24, NOW);

    expect(getDebugLoggingUntil()).toBeNull();
    expect(stateSaved()).toBe(true);
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

  it('logs and stays off when the saved file exists but cannot be read, without throwing', async () => {
    const { promises } = await import('fs');
    vi.mocked(promises.readFile).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('debug logging state'), expect.objectContaining({ code: 'EACCES' }));
    expect(setDebugLogFile).not.toHaveBeenCalledWith(true);
  });

  it('treats a missing or invalid until as nothing to restore', async () => {
    writeState(JSON.stringify({ until: 'soon' }));

    expect(await restoreDebugLogging(NOW)).toBeNull();
    expect(stateSaved()).toBe(false);
  });
});

describe('pruneOldDebugLogs', () => {
  const DAY = 24 * HOUR;

  function addLog(name: string, ageMs: number) {
    files.set(`logs/${name}`, '');
    mtimes.set(`logs/${name}`, NOW - ageMs);
  }

  it('deletes debug log files older than three days and keeps everything else', async () => {
    addLog('debug-2026-10-20.log', 6 * DAY);
    addLog('debug-2026-10-21.log.gz', 5 * DAY);
    addLog('debug-2026-10-22.log.1', 4 * DAY);
    addLog('debug-2026-10-25.log', DAY);
    addLog('combined-2026-10-20.log', 6 * DAY);
    files.set(DEBUG_LOGGING_STATE_FILE, '{}');

    expect(await pruneOldDebugLogs(NOW)).toBe(3);

    expect([...files.keys()].sort()).toEqual([
      'logs/combined-2026-10-20.log', 'logs/debug-2026-10-25.log', DEBUG_LOGGING_STATE_FILE,
    ].sort());
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Pruned 3 debug log file(s)'));
  });

  it('returns 0 without logging when there is nothing to prune or no log folder', async () => {
    const { promises } = await import('fs');
    vi.mocked(promises.readdir).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    expect(await pruneOldDebugLogs(NOW)).toBe(0);
    expect(await pruneOldDebugLogs(NOW)).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('skips a file it cannot read, with a warning, and carries on', async () => {
    const { promises } = await import('fs');
    addLog('debug-2026-10-19.log', 7 * DAY);
    addLog('debug-2026-10-20.log', 6 * DAY);
    vi.mocked(promises.stat).mockRejectedValueOnce(new Error('EACCES'));

    expect(await pruneOldDebugLogs(NOW)).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Couldn't prune old debug log"), expect.any(Error));
  });
});

describe('startDebugLogPruning', () => {
  it('prunes now and every six hours until stopped', async () => {
    const { promises } = await import('fs');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    startDebugLogPruning();
    startDebugLogPruning(); // a second start is a no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(promises.readdir).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(promises.readdir).toHaveBeenCalledTimes(2);

    stopDebugLogPruning();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(promises.readdir).toHaveBeenCalledTimes(2);
  });

  it('logs rather than throws if a prune fails unexpectedly', async () => {
    const { promises } = await import('fs');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.mocked(promises.readdir).mockResolvedValueOnce(null as never); // not iterable: an unexpected failure

    startDebugLogPruning();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.error).toHaveBeenCalledWith('Failed to prune old debug logs:', expect.any(TypeError));
  });
});
