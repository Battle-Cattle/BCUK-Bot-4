import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('./logger', () => ({ createLogger: () => mockLog }));

const config = vi.hoisted(() => ({ OVERLAY_FOLDER: '', DISK_FREE_ALERT_MB: 1024 }));
vi.mock('./config', () => config);

const recordDiskSpace = vi.hoisted(() => vi.fn());
vi.mock('./healthStore', () => ({ recordDiskSpace }));

import {
  checkDiskSpace, startDiskSpaceMonitor, stopDiskSpaceMonitor, DISK_CHECK_INTERVAL_MS, __resetDiskSpaceMonitorForTests,
} from './diskSpaceMonitor';
import { waitFor } from '../test-utils/waitFor';

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  __resetDiskSpaceMonitorForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-space-'));
  config.OVERLAY_FOLDER = dir;
  config.DISK_FREE_ALERT_MB = 1024;
});

afterEach(() => {
  __resetDiskSpaceMonitorForTests();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkDiskSpace', () => {
  it('counts only the blocks free to an unprivileged user (bavail), not those reserved for root (bfree)', async () => {
    const statfs = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 10, bfree: 50, bsize: 4096 } as fs.StatsFs);
    try {
      await checkDiskSpace();
      expect(statfs).toHaveBeenCalledWith(path.resolve(dir));
      expect(recordDiskSpace).toHaveBeenCalledWith(path.resolve(dir), 10 * 4096, 1024 * 1024 * 1024);
    } finally {
      statfs.mockRestore();
    }
  });

  it('records a real reading of the overlay folder\'s volume, with the path and the threshold in bytes', async () => {
    await checkDiskSpace();
    // Other processes change free space at any moment, so only check what that can't affect: the
    // exact figure is pinned by the stubbed test above.
    expect(recordDiskSpace).toHaveBeenCalledWith(path.resolve(dir), expect.any(Number), 1024 * 1024 * 1024);
    const freeBytes = recordDiskSpace.mock.calls[0]![1] as number; // toHaveBeenCalledWith above guarantees a call
    expect(Number.isInteger(freeBytes)).toBe(true);
    expect(freeBytes).toBeGreaterThanOrEqual(0);
  });

  it('records nothing and logs one warning per failure streak when statfs fails', async () => {
    config.OVERLAY_FOLDER = path.join(dir, 'missing');
    await checkDiskSpace();
    await checkDiskSpace();
    expect(recordDiskSpace).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledOnce();
    expect(mockLog.warn.mock.calls[0]![0]).toContain(path.join(dir, 'missing'));
    expect(mockLog.error).not.toHaveBeenCalled();

    config.OVERLAY_FOLDER = dir;
    await checkDiskSpace();
    expect(recordDiskSpace).toHaveBeenCalledOnce();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('working again'));

    config.OVERLAY_FOLDER = path.join(dir, 'missing');
    await checkDiskSpace();
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });
});

describe('startDiskSpaceMonitor', () => {
  it('checks once at start and then every interval until stopped', async () => {
    // Only the interval is faked: waitFor polls on a real setTimeout while the real statfs runs.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    startDiskSpaceMonitor();
    startDiskSpaceMonitor(); // a second start is a no-op
    await waitFor(() => expect(recordDiskSpace).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS);
    await waitFor(() => expect(recordDiskSpace).toHaveBeenCalledTimes(2));

    stopDiskSpaceMonitor();
    await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS * 3);
    expect(recordDiskSpace).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the previous check is still running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let finish!: (stats: fs.StatsFs) => void;
    const statfs = vi.spyOn(fs.promises, 'statfs').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    try {
      startDiskSpaceMonitor();
      await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS * 2);
      expect(statfs).toHaveBeenCalledTimes(1);

      finish({ bavail: 1, bsize: 1 } as fs.StatsFs);
      await waitFor(() => expect(recordDiskSpace).toHaveBeenCalledTimes(1));
      statfs.mockResolvedValue({ bavail: 2, bsize: 1 } as fs.StatsFs);
      await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS);
      await waitFor(() => expect(statfs).toHaveBeenCalledTimes(2));
    } finally {
      statfs.mockRestore();
    }
  });
});
