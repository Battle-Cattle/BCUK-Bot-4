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
  it('records the space free to the bot (bavail, not bfree) on the overlay folder\'s volume, with the threshold in bytes', async () => {
    const stats = await fs.promises.statfs(dir);
    await checkDiskSpace();
    expect(recordDiskSpace).toHaveBeenCalledOnce();
    const [recordedPath, freeBytes, thresholdBytes] = recordDiskSpace.mock.calls[0]!;
    expect(recordedPath).toBe(path.resolve(dir));
    expect(thresholdBytes).toBe(1024 * 1024 * 1024);
    // Free space moves between the two calls, but stays a whole number of blocks near bavail.
    expect(freeBytes % stats.bsize).toBe(0);
    expect(Math.abs(freeBytes - stats.bavail * stats.bsize)).toBeLessThan(64 * 1024 * 1024);
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
});
